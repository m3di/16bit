/*
 * A local stand-in for the rich text node set, used by RichTextView and RichTextEditor.
 *
 * This is NOT the definition. The node set is defined once in @16bit/core by #46. When that
 * lands, these types and `normalizeRichText` are replaced by the core contract and its
 * validation, and the two components switch their imports from this file to core. Everything
 * rich-text-shaped in the web app imports from here, so that switch touches one place.
 *
 * The shape is the ProseMirror JSON that Tiptap reads and writes. `normalizeRichText` drops
 * anything outside this set before it is rendered or emitted.
 */

export type RichMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'code' }
  | { type: 'link'; attrs: { href: string } }

export interface RichText {
  type: 'text'
  text: string
  marks?: RichMark[]
}
export interface RichHardBreak {
  type: 'hardBreak'
}
export type RichInline = RichText | RichHardBreak

export interface RichParagraph {
  type: 'paragraph'
  content?: RichInline[]
}
export interface RichHeading {
  type: 'heading'
  attrs: { level: RichHeadingLevel }
  content?: RichInline[]
}
export interface RichCodeBlock {
  type: 'codeBlock'
  /** Plain text only: no marks, no breaks. */
  content?: { type: 'text'; text: string }[]
}
export interface RichListItem {
  type: 'listItem'
  content: (RichParagraph | RichBulletList | RichOrderedList)[]
}
export interface RichBulletList {
  type: 'bulletList'
  content: RichListItem[]
}
export interface RichOrderedList {
  type: 'orderedList'
  attrs?: { start: number }
  content: RichListItem[]
}
export type RichBlock =
  RichParagraph | RichHeading | RichCodeBlock | RichBulletList | RichOrderedList

export interface RichDoc {
  type: 'doc'
  content: RichBlock[]
}

/** Item titles are the page's h1 and h2, so headings inside a document start at 3. */
export const HEADING_LEVELS = [3, 4] as const
export type RichHeadingLevel = (typeof HEADING_LEVELS)[number]

export const RICH_NODES = [
  'doc',
  'paragraph',
  'heading',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'text',
  'hardBreak',
] as const
export const RICH_MARKS = ['bold', 'italic', 'code', 'link'] as const

/** Nesting deeper than this is flattened away, so a hostile document cannot blow the stack. */
const MAX_LIST_DEPTH = 6

export const emptyDoc = (): RichDoc => ({ type: 'doc', content: [] })

/** Links may only point at the web or at mail. Anything else (javascript:, data:) is dropped. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function marksOf(raw: unknown): RichMark[] {
  const out: RichMark[] = []
  for (const m of list(raw)) {
    if (!isObject(m)) continue
    if (out.some((o) => o.type === m['type'])) continue
    if (m['type'] === 'bold' || m['type'] === 'italic' || m['type'] === 'code') {
      out.push({ type: m['type'] })
    } else if (m['type'] === 'link') {
      const href = safeHref(isObject(m['attrs']) ? m['attrs']['href'] : undefined)
      if (href) out.push({ type: 'link', attrs: { href } })
    }
  }
  return out
}

function inlines(raw: unknown): RichInline[] {
  const out: RichInline[] = []
  for (const n of list(raw)) {
    if (!isObject(n)) continue
    if (n['type'] === 'hardBreak') out.push({ type: 'hardBreak' })
    if (n['type'] === 'text' && typeof n['text'] === 'string' && n['text'] !== '') {
      const marks = marksOf(n['marks'])
      out.push(
        marks.length ? { type: 'text', text: n['text'], marks } : { type: 'text', text: n['text'] },
      )
    }
  }
  return out
}

const withContent = <T extends object>(node: T, content: RichInline[]) =>
  content.length ? { ...node, content } : node

function listItems(raw: unknown, depth: number): RichListItem[] {
  const items: RichListItem[] = []
  for (const n of list(raw)) {
    if (!isObject(n) || n['type'] !== 'listItem') continue
    const content: RichListItem['content'] = []
    for (const child of list(n['content'])) {
      const block = blockOf(child, depth + 1)
      if (
        block?.type === 'paragraph' ||
        block?.type === 'bulletList' ||
        block?.type === 'orderedList'
      ) {
        content.push(block)
      }
    }
    // A list item always starts with a paragraph, as ProseMirror's schema requires.
    if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' })
    items.push({ type: 'listItem', content })
  }
  return items
}

function blockOf(n: unknown, depth: number): RichBlock | null {
  if (!isObject(n)) return null
  const attrs = isObject(n['attrs']) ? n['attrs'] : {}
  switch (n['type']) {
    case 'paragraph':
      return withContent({ type: 'paragraph' as const }, inlines(n['content']))
    case 'heading': {
      const level = HEADING_LEVELS.find((l) => l === attrs['level']) ?? HEADING_LEVELS[0]
      return withContent({ type: 'heading' as const, attrs: { level } }, inlines(n['content']))
    }
    case 'codeBlock': {
      const text = inlines(n['content'])
        .map((i) => (i.type === 'text' ? i.text : '\n'))
        .join('')
      return text ? { type: 'codeBlock', content: [{ type: 'text', text }] } : { type: 'codeBlock' }
    }
    case 'bulletList':
    case 'orderedList': {
      if (depth >= MAX_LIST_DEPTH) return null
      const content = listItems(n['content'], depth)
      if (!content.length) return null
      if (n['type'] === 'bulletList') return { type: 'bulletList', content }
      const start = attrs['start']
      return typeof start === 'number' && Number.isInteger(start) && start > 1
        ? { type: 'orderedList', attrs: { start }, content }
        : { type: 'orderedList', content }
    }
    default:
      return null
  }
}

/**
 * Returns a document that holds only the closed node set. Unknown nodes and marks are dropped,
 * links with unsafe schemes lose their link, and anything that is not a document becomes an
 * empty one. Plain strings become paragraphs, so older text values still show.
 */
export function normalizeRichText(input: unknown): RichDoc {
  if (typeof input === 'string') {
    return {
      type: 'doc',
      content: input
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
    }
  }
  if (!isObject(input) || input['type'] !== 'doc') return emptyDoc()
  const content = list(input['content'])
    .map((n) => blockOf(n, 0))
    .filter((b): b is RichBlock => b !== null)
  return { type: 'doc', content }
}

/** Text with paragraphs separated by blank lines. For table cells, previews, and search. */
export function richTextToPlain(doc: RichDoc): string {
  const inline = (content: RichInline[] | undefined) =>
    (content ?? []).map((i) => (i.type === 'text' ? i.text : '\n')).join('')
  const block = (b: RichBlock): string => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
      case 'codeBlock':
        return inline(b.content)
      case 'bulletList':
      case 'orderedList':
        return b.content
          .map((item) => item.content.map(block).filter(Boolean).join('\n'))
          .join('\n')
    }
  }
  return doc.content.map(block).filter(Boolean).join('\n\n')
}

export function isRichTextEmpty(doc: RichDoc): boolean {
  return richTextToPlain(doc).trim() === ''
}
