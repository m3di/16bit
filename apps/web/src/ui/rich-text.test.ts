import { describe, expect, it } from 'vitest'
import {
  isRichTextEmpty,
  normalizeRichText,
  richTextToPlain,
  safeHref,
  type RichDoc,
} from './rich-text.ts'

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const doc = (...content: unknown[]) => ({ type: 'doc', content })

describe('safeHref', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com', 'http://example.com/'],
    ['mailto:sara@example.com', 'mailto:sara@example.com'],
    ['  https://example.com  ', 'https://example.com/'],
  ])('allows %s', (href, expected) => {
    expect(safeHref(href)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,x',
    'example.com',
    '',
    42,
  ])('refuses %s', (href) => {
    expect(safeHref(href)).toBeNull()
  })
})

describe('normalizeRichText', () => {
  it('keeps a document inside the node set unchanged', () => {
    const input: RichDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            {
              type: 'text',
              text: 'b',
              marks: [{ type: 'link', attrs: { href: 'https://x.io/' } }],
            },
          ],
        },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'H' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(normalizeRichText(input)).toEqual(input)
  })

  it('drops nodes and marks outside the set', () => {
    const input = doc(
      { type: 'image', attrs: { src: 'x' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'underline' }] }] },
      { type: 'table', content: [] },
    )
    expect(normalizeRichText(input)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
    })
  })

  it('drops links with unsafe schemes but keeps their text', () => {
    const input = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'x',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
        },
      ],
    })
    expect(normalizeRichText(input).content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'x' }],
    })
  })

  it('moves headings outside the allowed levels to the first level', () => {
    const out = normalizeRichText(doc({ type: 'heading', attrs: { level: 1 }, content: [] }))
    expect(out.content[0]).toEqual({ type: 'heading', attrs: { level: 3 } })
  })

  it('drops empty lists and gives list items a leading paragraph', () => {
    const out = normalizeRichText(
      doc(
        { type: 'bulletList', content: [] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p('x')] }] }],
            },
          ],
        },
      ),
    )
    expect(out.content).toHaveLength(1)
    const item = out.content[0]?.type === 'bulletList' ? out.content[0].content[0] : undefined
    expect(item?.content[0]).toEqual({ type: 'paragraph' })
  })

  it('stops at a bounded list depth', () => {
    let node: unknown = p('deep')
    for (let i = 0; i < 50; i++) {
      node = { type: 'bulletList', content: [{ type: 'listItem', content: [p('x'), node] }] }
    }
    expect(() => normalizeRichText(doc(node))).not.toThrow()
    expect(JSON.stringify(normalizeRichText(doc(node)))).not.toContain('deep')
  })

  it('flattens marks and breaks inside code blocks into text', () => {
    const out = normalizeRichText(
      doc({
        type: 'codeBlock',
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'b' },
        ],
      }),
    )
    expect(out.content[0]).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: 'a\nb' }] })
  })

  it('turns plain strings into paragraphs', () => {
    expect(normalizeRichText('one\n\ntwo')).toEqual(doc(p('one'), p('two')))
  })

  it.each([null, undefined, 3, [], { type: 'paragraph' }])(
    'turns %j into an empty document',
    (v) => {
      expect(normalizeRichText(v)).toEqual({ type: 'doc', content: [] })
    },
  )
})

describe('richTextToPlain and isRichTextEmpty', () => {
  it('joins blocks with blank lines and list items with newlines', () => {
    const d = normalizeRichText(
      doc(p('Intro'), {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p('a')] },
          { type: 'listItem', content: [p('b')] },
        ],
      }),
    )
    expect(richTextToPlain(d)).toBe('Intro\n\na\nb')
  })

  it('treats whitespace-only and empty paragraphs as empty', () => {
    expect(isRichTextEmpty(normalizeRichText(doc({ type: 'paragraph' }, p('  '))))).toBe(true)
    expect(isRichTextEmpty(normalizeRichText(doc(p('x'))))).toBe(false)
  })
})
