import { describe, expect, it } from 'vitest'
import {
  actorType,
  autoIdType,
  multiSelectType,
  relationType,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_DEPTH,
  richTextType,
  URL_MAX_LENGTH,
  urlType,
  type RichTextDoc,
} from './index.ts'

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success
const firstMessage = (schema: { safeParse(v: unknown): unknown }, v: unknown) =>
  (schema.safeParse(v) as { error?: { issues: { message: string }[] } }).error?.issues[0]?.message

describe('multi_select', () => {
  const config = multiSelectType.configSchema.parse({
    options: [
      { id: 'bug', label: 'Bug' },
      { id: 'ui', label: 'UI' },
      { id: 'api', label: 'API' },
    ],
  })
  const schema = multiSelectType.valueSchema(config)

  it('accepts distinct option IDs and refuses labels, unknowns, duplicates, and scalars', () => {
    expect(accepts(schema, ['bug', 'api'])).toBe(true)
    expect(accepts(schema, [])).toBe(true)
    expect(accepts(schema, ['Bug'])).toBe(false)
    expect(accepts(schema, ['nope'])).toBe(false)
    expect(accepts(schema, ['bug', 'bug'])).toBe(false)
    expect(accepts(schema, 'bug')).toBe(false)
  })

  it('caps the number of values', () => {
    const many = {
      options: Array.from({ length: 101 }, (_, i) => ({ id: `o${String(i)}`, label: 'x' })),
    }
    const s = multiSelectType.valueSchema(many)
    expect(
      accepts(
        s,
        many.options.slice(0, 100).map((o) => o.id),
      ),
    ).toBe(true)
    expect(
      accepts(
        s,
        many.options.map((o) => o.id),
      ),
    ).toBe(false)
  })

  it('treats an empty list as empty', () => {
    expect(multiSelectType.isEmpty([], config)).toBe(true)
    expect(multiSelectType.isEmpty(['ui'], config)).toBe(false)
  })

  it('projects one row per value in option order, deleted options last', () => {
    expect(multiSelectType.project(['api', 'gone', 'bug'], config)).toEqual(['bug', 'api', 'gone'])
  })

  it('sorts by its earliest option and groups by the combination', () => {
    expect(multiSelectType.sortKey(['api', 'ui'], config)).toBe(1)
    expect(multiSelectType.sortKey(['gone'], config)).toBe(3)
    expect(multiSelectType.groupKey(['api', 'bug'], config)).toBe('bug,api')
  })

  it('filters with list operators only and renders labels', () => {
    expect(multiSelectType.filterOperators).toEqual(['in', 'not_in', 'is_empty', 'is_not_empty'])
    expect(multiSelectType.render(['api', 'bug'], config)).toBe('Bug, API')
    expect(multiSelectType.render(null, config)).toBe('')
  })

  it('emits an array of the option enum for agents', () => {
    expect(multiSelectType.jsonSchema(config)).toMatchObject({
      type: 'array',
      uniqueItems: true,
      maxItems: 100,
      items: { type: 'string', enum: ['bug', 'ui', 'api'] },
    })
  })
})

describe('url', () => {
  const schema = urlType.valueSchema({})

  it('accepts http and https URLs only', () => {
    expect(accepts(schema, 'https://16bit.info/docs?x=1#y')).toBe(true)
    expect(accepts(schema, 'http://localhost:5173')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'ftp://a.com', 'a.com', '', 42]) {
      expect(accepts(schema, bad), String(bad)).toBe(false)
    }
  })

  it('caps the length', () => {
    const base = 'https://a.com/'
    expect(accepts(schema, base + 'x'.repeat(URL_MAX_LENGTH - base.length))).toBe(true)
    expect(accepts(schema, base + 'x'.repeat(URL_MAX_LENGTH - base.length + 1))).toBe(false)
  })

  it('indexes as text, sorts case-insensitively, and has the text operators', () => {
    expect(urlType.project('https://A.com', {})).toEqual(['https://A.com'])
    expect(urlType.sortKey('https://A.com', {})).toBe('https://a.com')
    expect(urlType.filterOperators).toEqual(
      expect.arrayContaining(['eq', 'contains', 'starts_with', 'is_empty']),
    )
    expect(urlType.jsonSchema({})).toEqual({ type: 'string', format: 'uri', maxLength: 2048 })
  })
})

describe('actor', () => {
  const single = actorType.configSchema.parse({})
  const multiple = actorType.configSchema.parse({ multiple: true })

  it('is a list of principal IDs, one at most unless multiple', () => {
    expect(single.multiple).toBe(false)
    expect(accepts(actorType.valueSchema(single), ['p1'])).toBe(true)
    expect(accepts(actorType.valueSchema(single), ['p1', 'p2'])).toBe(false)
    expect(accepts(actorType.valueSchema(multiple), ['p1', 'p2'])).toBe(true)
    expect(accepts(actorType.valueSchema(multiple), ['p1', 'p1'])).toBe(false)
    expect(accepts(actorType.valueSchema(single), ['a b'])).toBe(false)
    expect(accepts(actorType.valueSchema(single), 'p1')).toBe(false)
  })

  it('projects one row per principal and is not sortable', () => {
    expect(actorType.project(['p2', 'p1'], multiple)).toEqual(['p2', 'p1'])
    expect(actorType.sortable).toBe(false)
    expect(actorType.groupKey(['p2', 'p1'], multiple)).toBe('p1,p2')
    expect(actorType.filterOperators).toEqual(['in', 'not_in', 'is_empty', 'is_not_empty'])
  })

  it('emits a bounded array for agents', () => {
    expect(actorType.jsonSchema(single)).toMatchObject({ type: 'array', maxItems: 1 })
    expect(actorType.jsonSchema(multiple)).toMatchObject({ type: 'array', maxItems: 50 })
  })
})

describe('auto_id', () => {
  it('is read-only, a positive integer, and indexed as a number', () => {
    expect(autoIdType.readOnly).toBe(true)
    const schema = autoIdType.valueSchema({})
    expect(accepts(schema, 12)).toBe(true)
    expect(accepts(schema, 0)).toBe(false)
    expect(accepts(schema, 1.5)).toBe(false)
    expect(accepts(schema, '12')).toBe(false)
    expect(autoIdType.project(12, {})).toEqual([12])
    expect(autoIdType.indexProjection).toBe('num')
  })

  it('renders with the optional prefix and tells agents not to send it', () => {
    expect(autoIdType.render(12, { prefix: 'BLD' })).toBe('BLD-12')
    expect(autoIdType.render(12, {})).toBe('12')
    expect(accepts(autoIdType.configSchema, { prefix: 'bld' })).toBe(false)
    expect(autoIdType.jsonSchema({})).toMatchObject({ type: 'integer', readOnly: true })
  })
})

describe('relation', () => {
  it('defaults to a same-hub, multiple relation', () => {
    expect(relationType.configSchema.parse({ targetHubId: 'h1' })).toEqual({
      targetHubId: 'h1',
      crossHub: false,
      multiple: true,
    })
    expect(accepts(relationType.configSchema, {})).toBe(false)
  })

  it('is a list of distinct item IDs, capped by multiple', () => {
    const many = relationType.valueSchema({ targetHubId: 'h', crossHub: false, multiple: true })
    const one = relationType.valueSchema({ targetHubId: 'h', crossHub: false, multiple: false })
    expect(accepts(many, ['i1', 'i2'])).toBe(true)
    expect(accepts(many, ['i1', 'i1'])).toBe(false)
    expect(
      accepts(
        many,
        Array.from({ length: 101 }, (_, i) => `i${String(i)}`),
      ),
    ).toBe(false)
    expect(accepts(one, ['i1', 'i2'])).toBe(false)
    expect(accepts(one, ['__proto__'])).toBe(false)
  })

  it('projects one row per linked item and is not sortable', () => {
    const config = { targetHubId: 'h', crossHub: false, multiple: true }
    expect(relationType.project(['i2', 'i1'], config)).toEqual(['i2', 'i1'])
    expect(relationType.isEmpty([], config)).toBe(true)
    expect(relationType.sortable).toBe(false)
    expect(relationType.jsonSchema(config)).toMatchObject({ type: 'array', maxItems: 100 })
  })
})

describe('rich_text', () => {
  const schema = richTextType.valueSchema({})
  const doc = (...content: unknown[]) => ({ type: 'doc', content })
  const p = (...content: unknown[]) => ({ type: 'paragraph', content })
  const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks && { marks }) })
  const li = (...content: unknown[]) => ({ type: 'listItem', content })

  const sample = doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
    p(t('Ship '), t('M1', [{ type: 'bold' }]), t(' by '), t('Friday', [{ type: 'italic' }])),
    { type: 'bulletList', content: [li(p(t('one'))), li(p(t('two')))] },
    { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('three')))] },
    { type: 'blockquote', content: [p(t('quoted'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const x = 1')] },
    { type: 'horizontalRule' },
    p(
      t('see '),
      t('docs', [{ type: 'link', attrs: { href: 'https://16bit.info' } }]),
      { type: 'hardBreak' },
      t('end'),
    ),
  )

  it('accepts every node and mark in the set', () => {
    expect(schema.safeParse(sample).error?.issues).toBeUndefined()
  })

  it.each([
    ['an unknown node', doc({ type: 'table', content: [] }), 'not an allowed block'],
    ['an unknown mark', doc(p(t('x', [{ type: 'underline' }]))), 'Unknown mark'],
    [
      'an extra attribute',
      doc(p(t('x', [{ type: 'link', attrs: { href: 'https://a.com', target: '_blank' } }]))),
      'Unknown key "target"',
    ],
    [
      'a javascript link',
      doc(p(t('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
      'http, https or mailto',
    ],
    ['a repeated mark', doc(p(t('x', [{ type: 'bold' }, { type: 'bold' }]))), 'repeated'],
    ['empty text', doc(p(t(''))), 'non-empty string'],
    ['a block inline', doc(p(p(t('x')))), 'not allowed inline'],
    [
      'a heading level 4',
      doc({ type: 'heading', attrs: { level: 4 }, content: [] }),
      'Heading level',
    ],
    [
      'marks in code',
      doc({ type: 'codeBlock', content: [t('x', [{ type: 'bold' }])] }),
      'Unknown key "marks"',
    ],
    ['a non-item in a list', doc({ type: 'bulletList', content: [p(t('x'))] }), 'listItem'],
    ['an empty list', doc({ type: 'bulletList', content: [] }), 'Must not be empty'],
    ['a non-doc root', p(t('x')), 'Expected a doc'],
    ['a string', 'hello', 'Expected a doc'],
  ])('rejects %s', (_, value, message) => {
    expect(firstMessage(schema, value)).toContain(message)
  })

  it('names the path of the problem', () => {
    expect(firstMessage(schema, doc(p(t('a')), p(t('b', [{ type: 'nope' }]))))).toBe(
      'Unknown mark "nope" at content.1.content.0.marks.0.type',
    )
  })

  it(`caps nesting at ${String(RICH_TEXT_MAX_DEPTH)} levels`, () => {
    const nest = (levels: number): unknown =>
      levels === 0 ? p(t('x')) : { type: 'blockquote', content: [nest(levels - 1)] }
    // doc (1) + blockquotes + paragraph
    expect(accepts(schema, doc(nest(RICH_TEXT_MAX_DEPTH - 2)))).toBe(true)
    expect(firstMessage(schema, doc(nest(RICH_TEXT_MAX_DEPTH - 1)))).toContain('Nested too deeply')
  })

  it(`caps the document at ${String(RICH_TEXT_MAX_BYTES)} bytes of JSON`, () => {
    const overhead = JSON.stringify(doc(p(t('')))).length
    const fits = doc(p(t('x'.repeat(RICH_TEXT_MAX_BYTES - overhead))))
    expect(accepts(schema, fits)).toBe(true)
    expect(accepts(schema, doc(p(t('x'.repeat(RICH_TEXT_MAX_BYTES - overhead + 1)))))).toBe(false)
    // Counted in UTF-8: a three-byte character uses three bytes of the cap.
    const wide = doc(p(t('€'.repeat(Math.ceil(RICH_TEXT_MAX_BYTES / 3)))))
    expect(firstMessage(schema, wide)).toContain('bytes of JSON')
  })

  it('treats a document without text as empty', () => {
    expect(richTextType.isEmpty({ type: 'doc', content: [] }, {})).toBe(true)
    expect(richTextType.isEmpty({ type: 'doc', content: [{ type: 'paragraph' }] }, {})).toBe(true)
    expect(richTextType.isEmpty(sample as RichTextDoc, {})).toBe(false)
  })

  it('projects plain text for contains filters and is not sortable', () => {
    expect(richTextType.project(sample as RichTextDoc, {})).toEqual([
      'Plan\nShip M1 by Friday\none\ntwo\nthree\nquoted\nconst x = 1\nsee docs\nend',
    ])
    expect(richTextType.filterOperators).toEqual([
      'contains',
      'not_contains',
      'is_empty',
      'is_not_empty',
    ])
    expect(richTextType.sortable).toBe(false)
  })

  it('renders Markdown for agents', () => {
    expect(richTextType.render(sample as RichTextDoc, {})).toBe(
      [
        '## Plan',
        '',
        'Ship **M1** by *Friday*',
        '',
        '- one',
        '- two',
        '',
        '3. three',
        '',
        '> quoted',
        '',
        '```ts',
        'const x = 1',
        '```',
        '',
        '---',
        '',
        'see [docs](https://16bit.info)  ',
        'end',
      ].join('\n'),
    )
    expect(richTextType.render(null, {})).toBe('')
  })

  it('emits a closed JSON Schema for agents', () => {
    expect(richTextType.jsonSchema({})).toMatchObject({
      type: 'object',
      required: ['type', 'content'],
      additionalProperties: false,
    })
  })
})
