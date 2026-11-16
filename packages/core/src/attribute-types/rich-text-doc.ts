import { z } from 'zod'

// The closed node set for rich text values (D44). The shape is ProseMirror JSON, so the
// Tiptap editor (docs/ARCHITECTURE.md) reads and writes it directly once it is limited to
// these nodes and marks and their listed attributes. Anything else is refused, including
// extra attributes such as a link's `target`, `rel` or `class`. It matches the set the
// shared RichTextEditor and RichTextView were built for (#48).

/** UTF-8 bytes of the value's JSON. Long-form text belongs in a document attribute (M2). */
export const RICH_TEXT_MAX_BYTES = 65_536
/**
 * Node nesting, counting `doc` as 1 and not counting inline nodes. A list and its item take
 * two levels each, so this allows lists six deep, as the editor does.
 */
export const RICH_TEXT_MAX_DEPTH = 14
/** Item titles are the page's h1 and h2, so headings inside a value start at 3 (#48). */
export const RICH_TEXT_HEADING_LEVELS = [3, 4] as const
export const RICH_TEXT_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const

export type RichTextMark =
  { type: 'bold' | 'italic' | 'code' } | { type: 'link'; attrs: { href: string } }

export interface RichTextText {
  type: 'text'
  /** Never empty. */
  text: string
  /** Each mark type at most once. */
  marks?: RichTextMark[]
}
export interface RichTextHardBreak {
  type: 'hardBreak'
}
export type RichTextInline = RichTextText | RichTextHardBreak

export interface RichTextParagraph {
  type: 'paragraph'
  content?: RichTextInline[]
}
export interface RichTextHeading {
  type: 'heading'
  attrs: { level: (typeof RICH_TEXT_HEADING_LEVELS)[number] }
  content?: RichTextInline[]
}
export interface RichTextListItem {
  type: 'listItem'
  /** Starts with a paragraph, as ProseMirror's list schema requires. */
  content: [RichTextParagraph, ...(RichTextParagraph | RichTextBulletList | RichTextOrderedList)[]]
}
export interface RichTextBulletList {
  type: 'bulletList'
  content: RichTextListItem[]
}
export interface RichTextOrderedList {
  type: 'orderedList'
  attrs?: { start: number }
  content: RichTextListItem[]
}
export interface RichTextCodeBlock {
  type: 'codeBlock'
  /** Plain text only: no marks, no hard breaks (newlines are kept in the text). */
  content?: { type: 'text'; text: string }[]
}
export type RichTextBlock =
  RichTextParagraph | RichTextHeading | RichTextBulletList | RichTextOrderedList | RichTextCodeBlock

export interface RichTextDoc {
  type: 'doc'
  /** An empty list, or only blocks without text, is an empty value. */
  content: RichTextBlock[]
}

export const RICH_TEXT_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'codeBlock',
] as const
export const RICH_TEXT_MARK_TYPES = ['bold', 'italic', 'code', 'link'] as const

// Validation. Hand-written rather than a recursive Zod union: it stops at the depth cap before
// recursing further, and names the exact path of the first problem.

class Invalid extends Error {
  readonly path: (string | number)[]
  constructor(path: (string | number)[], message: string) {
    super(message)
    this.path = path
  }
}

type Path = (string | number)[]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function keysOnly(node: Record<string, unknown>, allowed: readonly string[], path: Path) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Invalid([...path, key], `Unknown key "${key}"`)
  }
}

function list(node: Record<string, unknown>, key: string, path: Path, required: boolean) {
  const value = node[key]
  if (value === undefined && !required) return []
  if (!Array.isArray(value)) throw new Invalid([...path, key], 'Expected an array')
  if (required && value.length === 0) throw new Invalid([...path, key], 'Must not be empty')
  return value as unknown[]
}

function attrs(node: Record<string, unknown>, path: Path, required: boolean) {
  const value = node.attrs
  if (value === undefined && !required) return undefined
  if (!isRecord(value)) throw new Invalid([...path, 'attrs'], 'Expected an object')
  return value
}

function isLinkHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length > 2048) return false
  try {
    return (RICH_TEXT_LINK_PROTOCOLS as readonly string[]).includes(new URL(href).protocol)
  } catch {
    return false
  }
}

function checkMark(mark: unknown, path: Path): string {
  if (!isRecord(mark)) throw new Invalid(path, 'Expected a mark')
  const { type } = mark
  if (!(RICH_TEXT_MARK_TYPES as readonly unknown[]).includes(type)) {
    throw new Invalid([...path, 'type'], `Unknown mark "${String(type)}"`)
  }
  if (type === 'link') {
    keysOnly(mark, ['type', 'attrs'], path)
    const a = attrs(mark, path, true)
    keysOnly(a ?? {}, ['href'], [...path, 'attrs'])
    if (!isLinkHref(a?.href)) {
      throw new Invalid([...path, 'attrs', 'href'], 'Links must be http, https or mailto URLs')
    }
  } else {
    keysOnly(mark, ['type'], path)
  }
  return type as string
}

function checkText(node: Record<string, unknown>, path: Path, marksAllowed: boolean) {
  keysOnly(node, marksAllowed ? ['type', 'text', 'marks'] : ['type', 'text'], path)
  if (typeof node.text !== 'string' || node.text === '') {
    throw new Invalid([...path, 'text'], 'Expected a non-empty string')
  }
  const seen = new Set<string>()
  for (const [i, mark] of list(node, 'marks', path, false).entries()) {
    const type = checkMark(mark, [...path, 'marks', i])
    if (seen.has(type)) throw new Invalid([...path, 'marks', i], `Mark "${type}" is repeated`)
    seen.add(type)
  }
}

function checkInline(node: unknown, path: Path) {
  if (!isRecord(node)) throw new Invalid(path, 'Expected a node')
  if (node.type === 'text') {
    checkText(node, path, true)
    return
  }
  if (node.type === 'hardBreak') {
    keysOnly(node, ['type'], path)
    return
  }
  throw new Invalid([...path, 'type'], `"${String(node.type)}" is not allowed inline`)
}

function checkBlocks(nodes: unknown[], path: Path, depth: number) {
  for (const [i, node] of nodes.entries()) checkBlock(node, [...path, i], depth)
}

const LIST_ITEM_CHILDREN: readonly unknown[] = ['paragraph', 'bulletList', 'orderedList']

function checkListItems(nodes: unknown[], path: Path, depth: number) {
  if (depth > RICH_TEXT_MAX_DEPTH) throw new Invalid(path, 'Nested too deeply')
  for (const [i, node] of nodes.entries()) {
    const itemPath = [...path, i]
    if (!isRecord(node) || node.type !== 'listItem') {
      throw new Invalid(itemPath, 'Lists hold listItem nodes only')
    }
    keysOnly(node, ['type', 'content'], itemPath)
    const children = list(node, 'content', itemPath, true)
    for (const [j, child] of children.entries()) {
      const childPath = [...itemPath, 'content', j]
      const type = isRecord(child) ? child.type : undefined
      if (j === 0 ? type !== 'paragraph' : !LIST_ITEM_CHILDREN.includes(type)) {
        throw new Invalid(
          childPath,
          j === 0
            ? 'A list item starts with a paragraph'
            : 'A list item holds paragraphs and lists only',
        )
      }
      checkBlock(child, childPath, depth + 1)
    }
  }
}

function checkBlock(node: unknown, path: Path, depth: number): void {
  if (depth > RICH_TEXT_MAX_DEPTH) throw new Invalid(path, 'Nested too deeply')
  if (!isRecord(node)) throw new Invalid(path, 'Expected a node')
  const content = [...path, 'content']
  switch (node.type) {
    case 'paragraph':
      keysOnly(node, ['type', 'content'], path)
      for (const [i, child] of list(node, 'content', path, false).entries()) {
        checkInline(child, [...content, i])
      }
      return
    case 'heading': {
      keysOnly(node, ['type', 'attrs', 'content'], path)
      const a = attrs(node, path, true) ?? {}
      keysOnly(a, ['level'], [...path, 'attrs'])
      if (!(RICH_TEXT_HEADING_LEVELS as readonly unknown[]).includes(a.level)) {
        throw new Invalid([...path, 'attrs', 'level'], 'Heading level must be 3 or 4')
      }
      for (const [i, child] of list(node, 'content', path, false).entries()) {
        checkInline(child, [...content, i])
      }
      return
    }
    case 'bulletList':
      keysOnly(node, ['type', 'content'], path)
      checkListItems(list(node, 'content', path, true), content, depth + 1)
      return
    case 'orderedList': {
      keysOnly(node, ['type', 'attrs', 'content'], path)
      const a = attrs(node, path, false)
      if (a) {
        keysOnly(a, ['start'], [...path, 'attrs'])
        if (!Number.isSafeInteger(a.start) || (a.start as number) < 1) {
          throw new Invalid([...path, 'attrs', 'start'], 'Expected a positive integer')
        }
      }
      checkListItems(list(node, 'content', path, true), content, depth + 1)
      return
    }
    case 'codeBlock': {
      keysOnly(node, ['type', 'content'], path)
      for (const [i, child] of list(node, 'content', path, false).entries()) {
        if (!isRecord(child) || child.type !== 'text') {
          throw new Invalid([...content, i], 'Code blocks hold text only')
        }
        checkText(child, [...content, i], false)
      }
      return
    }
    default:
      throw new Invalid([...path, 'type'], `"${String(node.type)}" is not an allowed block`)
  }
}

/** UTF-8 length without TextEncoder, so this stays free of runtime APIs. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function checkDoc(value: unknown) {
  if (!isRecord(value) || value.type !== 'doc') throw new Invalid([], 'Expected a doc node')
  keysOnly(value, ['type', 'content'], [])
  // Required, but may be empty: `{ type: 'doc', content: [] }` is the empty value.
  if (!Array.isArray(value.content)) throw new Invalid(['content'], 'Expected an array')
  checkBlocks(value.content as unknown[], ['content'], 2)
  // After the walk, so the depth cap bounds what is serialised.
  if (utf8Length(JSON.stringify(value)) > RICH_TEXT_MAX_BYTES) {
    throw new Invalid([], `Rich text is limited to ${String(RICH_TEXT_MAX_BYTES)} bytes of JSON`)
  }
}

/** A rich text document in the closed node set, within the size and depth caps. */
export const richTextDocSchema = z.custom<RichTextDoc>().superRefine((value, ctx) => {
  try {
    checkDoc(value)
  } catch (error) {
    if (!(error instanceof Invalid)) throw error
    const where = error.path.length > 0 ? ` at ${error.path.join('.')}` : ''
    ctx.addIssue({ code: 'custom', message: `${error.message}${where}`, path: error.path })
  }
})

// Renderings. Both expect a validated document.

const inlineText = (nodes: readonly RichTextInline[] | undefined) =>
  (nodes ?? []).map((n) => (n.type === 'text' ? n.text : '\n')).join('')

function blockLines(block: RichTextBlock): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return [inlineText(block.content)]
    case 'codeBlock':
      return [(block.content ?? []).map((n) => n.text).join('')]
    case 'bulletList':
    case 'orderedList':
      return block.content.flatMap((item) => item.content.flatMap(blockLines))
  }
}

/** The document's text without markup, one line per block. Used for the index projection. */
export function richTextPlainText(doc: RichTextDoc): string {
  return doc.content.flatMap(blockLines).join('\n')
}

const MARK_WRAP: Record<'bold' | 'italic', string> = { bold: '**', italic: '*' }

/** Backslash-escapes the characters that could start Markdown links, emphasis, code or HTML. */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>]/g, '\\$&')

/** The longest run of backticks in the text, so a fence or code span can be made longer. */
const longestBacktickRun = (text: string) =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))

/** A code span that holds any text: backslashes do not escape inside one, so lengthen the fence. */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** A link destination in angle brackets, with the characters that could end it encoded. */
const linkDestination = (href: string) =>
  `<${href.replace(/[\s<>\\]/g, (c) => encodeURIComponent(c))}>`

function markdownInline(nodes: readonly RichTextInline[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n'
      const marks = node.marks ?? []
      // Text is escaped so it can never produce a link that skips the href allowlist.
      let text = marks.some((m) => m.type === 'code')
        ? codeSpan(node.text)
        : escapeMarkdown(node.text)
      let href: string | undefined
      for (const mark of marks) {
        if (mark.type === 'link') href = mark.attrs.href
        else if (mark.type !== 'code')
          text = `${MARK_WRAP[mark.type]}${text}${MARK_WRAP[mark.type]}`
      }
      return href === undefined ? text : `[${text}](${linkDestination(href)})`
    })
    .join('')
}

const indent = (lines: string[], prefix: string, rest: string) =>
  lines.map((line, i) => (line === '' ? line : `${i === 0 ? prefix : rest}${line}`))

function markdownBlock(block: RichTextBlock): string[] {
  switch (block.type) {
    case 'paragraph':
      return [markdownInline(block.content)]
    case 'heading':
      return [`${'#'.repeat(block.attrs.level)} ${markdownInline(block.content)}`]
    case 'codeBlock': {
      const code = (block.content ?? []).map((n) => n.text).join('')
      // Longer than any backtick run inside, so the code cannot close the fence early.
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1))
      return [fence, code, fence]
    }
    case 'bulletList':
    case 'orderedList': {
      const start = block.type === 'orderedList' ? (block.attrs?.start ?? 1) : 1
      return block.content.flatMap((item, i) => {
        const marker = block.type === 'orderedList' ? `${String(start + i)}. ` : '- '
        const lines = markdownBlocks(item.content).filter((line) => line !== '')
        return indent(lines, marker, ' '.repeat(marker.length))
      })
    }
  }
}

function markdownBlocks(blocks: readonly RichTextBlock[]): string[] {
  return blocks.flatMap((block, i) => (i === 0 ? [] : ['']).concat(markdownBlock(block)))
}

/** The document as Markdown, the plain-text agent form. */
export function richTextToMarkdown(doc: RichTextDoc): string {
  return markdownBlocks(doc.content).join('\n')
}
