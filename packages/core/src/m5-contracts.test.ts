import { describe, expect, it } from 'vitest'
import {
  acceptInviteSchema,
  API_ERROR_CODES,
  applyAttributeUpdate,
  checkHubTemplate,
  compileItemQuery,
  createAttributeSchema,
  createInviteSchema,
  dateConfigSchema,
  defaultViewTree,
  digestQuerySchema,
  digestSchema,
  EXTERNAL_LOGIN_MAX_LENGTH,
  externalLoginSchema,
  filterOperatorsOf,
  freshForMs,
  freshForSchema,
  HUB_TEMPLATE_FORMAT,
  importHubTemplateSchema,
  inviteSchema,
  MAX_DIGEST_BYTES,
  MAX_NEIGHBOUR_NODES,
  MCP_LATER_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  MCP_WAVE_1_TOOLS,
  neighboursQuerySchema,
  neighboursSchema,
  searchQuerySchema,
  searchResultSchema,
  staleErrorSchema,
  updateAttributeSchema,
  type Attribute,
  type HubTemplateInput,
  type Item,
} from './index.ts'

// M5 contracts (#205): freshness (D69), invites by external login (D72), the digest (D86),
// neighbours (D67), search (D70), hub templates (D71) and the MCP tools (D88).

const item: Item = {
  workspaceId: 'w1',
  id: 'i1',
  hubId: 'h1',
  folderId: 'f1',
  seqId: 1,
  values: {},
  version: 1,
  updatedAt: '2026-11-28T10:00:00.000Z',
  updatedBy: 'p1',
}

const date = (config: Record<string, unknown>): Attribute => ({
  workspaceId: 'w1',
  id: 'due',
  hubId: 'h1',
  name: 'Due',
  type: 'date',
  indexed: true,
  version: 0,
  config: dateConfigSchema.parse(config),
})

describe('freshFor (D69)', () => {
  it.each([
    ['PT1M', 60_000],
    ['PT2H', 7_200_000],
    ['P7D', 604_800_000],
    ['P1W2DT3H', 9 * 86_400_000 + 3 * 3_600_000],
    ['P366D', 366 * 86_400_000],
    ['PT90S', 90_000],
  ])('takes %s', (duration, ms) => {
    expect(freshForMs(duration)).toBe(ms)
    expect(freshForSchema.safeParse(duration).success).toBe(true)
  })

  it.each(['PT59S', 'PT0S', 'P367D', '-PT2H', 'P1M', 'P1Y', 'PT', 'P', 'pt2h', '2h', ''])(
    'refuses %j',
    (duration) => {
      expect(freshForMs(duration)).toBeNull()
      expect(freshForSchema.safeParse(duration).success).toBe(false)
    },
  )

  it('is an optional date config', () => {
    expect(dateConfigSchema.parse({})).toEqual({ includeTime: false })
    expect(dateConfigSchema.parse({ includeTime: true, freshFor: 'PT2H' })).toEqual({
      includeTime: true,
      freshFor: 'PT2H',
    })
    const created = createAttributeSchema.safeParse({
      name: 'Claimed until',
      type: 'date',
      config: { includeTime: true, freshFor: 'PT2H' },
    })
    expect(created.success).toBe(true)
    expect(
      createAttributeSchema.safeParse({ name: 'x', type: 'text', config: { freshFor: 'PT2H' } })
        .success,
    ).toBe(false)
  })

  it('is set, changed and cleared by an attribute patch, and only on dates', () => {
    expect(updateAttributeSchema.safeParse({ version: 0, freshFor: 'P1D' }).success).toBe(true)
    expect(updateAttributeSchema.safeParse({ version: 0, freshFor: null }).success).toBe(true)
    expect(updateAttributeSchema.safeParse({ version: 0, freshFor: 'P1M' }).success).toBe(false)

    const set = applyAttributeUpdate(date({}), { version: 0, freshFor: 'P1D' })
    expect(set.ok && set.attribute.config).toEqual({ includeTime: false, freshFor: 'P1D' })
    const cleared = applyAttributeUpdate(date({ freshFor: 'P1D' }), { version: 0, freshFor: null })
    expect(cleared.ok && cleared.attribute.config).toEqual({ includeTime: false })
    expect(cleared.ok && cleared.removedOptionIds).toEqual([])

    const text = { ...date({}), type: 'text', config: {} } as Attribute
    expect(applyAttributeUpdate(text, { version: 0, freshFor: 'P1D' })).toEqual({
      ok: false,
      message: 'A text attribute has no freshFor',
    })
  })
})

describe('is_stale (D69)', () => {
  const where = (attribute: Attribute, value?: unknown) =>
    compileItemQuery([attribute], {
      where: { attribute: 'due', op: 'is_stale', ...(value === undefined ? {} : { value }) },
      sort: [],
    })

  it('compiles on a date with freshFor, to the duration in milliseconds', () => {
    expect(where(date({ freshFor: 'PT2H' }))).toEqual({
      ok: true,
      where: {
        condition: { attributeId: 'due', column: 'ts', op: 'is_stale', operands: [7_200_000] },
      },
      sort: [],
      expand: [],
    })
    expect(filterOperatorsOf(date({ freshFor: 'PT2H' }))).toContain('is_stale')
  })

  it('is refused on a date without freshFor, saying why', () => {
    const result = where(date({}))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors[0]?.message).toMatch(
      /^Operator "is_stale" needs a freshFor on date attribute "due"; use one of eq, /,
    )
    expect(filterOperatorsOf(date({}))).not.toContain('is_stale')
  })

  it('takes no value', () => {
    const result = where(date({ freshFor: 'PT2H' }), '2026-11-28')
    expect(!result.ok && result.errors).toEqual([
      { path: 'where.value', message: 'is_stale on "due": takes no value' },
    ])
  })

  it('is refused on other types', () => {
    const text = { ...date({}), type: 'text', config: {} } as Attribute
    const result = compileItemQuery([text], {
      where: { attribute: 'due', op: 'is_stale' },
      sort: [],
    })
    expect(!result.ok && result.errors[0]?.message).toMatch(
      /^Operator "is_stale" is not supported on text attribute "due"/,
    )
  })
})

describe('external login (D72)', () => {
  it.each([
    ['a user name', 'mina', true],
    ['an email-like login', 'Mina.K@corp.example', true],
    ['a domain login', 'CORP\\mina', true],
    ['inner spaces', 'Mina K', true],
    ['256 code points', '😀'.repeat(EXTERNAL_LOGIN_MAX_LENGTH), true],
    ['empty', '', false],
    ['257 code points', 'a'.repeat(EXTERNAL_LOGIN_MAX_LENGTH + 1), false],
    ['a leading space', ' mina', false],
    ['a trailing tab', 'mina\t', false],
    ['a newline inside', 'mi\nna', false],
    ['DEL inside', 'mi\u007fna', false],
  ])('%s: %j', (_, login, valid) => {
    expect(externalLoginSchema.safeParse(login).success).toBe(valid)
  })

  it('is compared exactly: no trimming or case folding', () => {
    expect(externalLoginSchema.parse('Mina')).toBe('Mina')
  })

  it('binds an invite, which lists it', () => {
    expect(createInviteSchema.parse({ workspaceRole: 'member', externalLogin: 'mina' })).toEqual({
      workspaceRole: 'member',
      expiresInDays: 7,
      externalLogin: 'mina',
    })
    const invite = {
      workspaceId: 'w1',
      id: 'inv1',
      workspaceRole: 'member',
      createdBy: 'p1',
      createdAt: '2026-11-28T10:00:00.000Z',
      expiresAt: '2026-12-05T10:00:00.000Z',
    }
    expect(inviteSchema.safeParse(invite).success).toBe(true)
    expect(inviteSchema.safeParse({ ...invite, externalLogin: 'mina' }).success).toBe(true)
  })

  it('is accepted without a password, and only with a name and email', () => {
    const account = { name: 'Mina', email: 'Mina@Corp.example' }
    expect(acceptInviteSchema.parse(account)).toEqual({ name: 'Mina', email: 'mina@corp.example' })
    expect(acceptInviteSchema.parse({ ...account, password: 'a long password' })).toEqual({
      name: 'Mina',
      email: 'mina@corp.example',
      password: 'a long password',
    })
    expect(acceptInviteSchema.parse({})).toEqual({})
    expect(acceptInviteSchema.safeParse({ name: 'Mina' }).success).toBe(false)
    expect(acceptInviteSchema.safeParse({ ...account, externalLogin: 'mina' }).success).toBe(false)
  })

  it('has its error codes', () => {
    expect(API_ERROR_CODES).toContain('login_taken')
    expect(API_ERROR_CODES).toContain('invalid_template')
  })
})

describe('digest (D86)', () => {
  it('takes an optional version and tz', () => {
    expect(digestQuerySchema.parse({})).toEqual({})
    expect(digestQuerySchema.parse({ version: '3', tz: 'Asia/Tehran' })).toEqual({
      version: 3,
      tz: 'Asia/Tehran',
    })
    expect(digestQuerySchema.safeParse({ version: '-1' }).success).toBe(false)
    expect(digestQuerySchema.safeParse({ blocks: 'a' }).success).toBe(false)
  })

  it('answers seq, version, markdown and truncated, at most 32 KiB of UTF-8', () => {
    const body = { seq: 10, version: 2, markdown: '# Home\n', truncated: false }
    expect(digestSchema.parse(body)).toEqual(body)
    expect(
      digestSchema.safeParse({ ...body, markdown: 'a'.repeat(MAX_DIGEST_BYTES) }).success,
    ).toBe(true)
    // 3 bytes each in UTF-8, so a third as many characters already passes the cap.
    const wide = '€'.repeat(Math.floor(MAX_DIGEST_BYTES / 3) + 1)
    expect(digestSchema.safeParse({ ...body, markdown: wide }).success).toBe(false)
    expect(digestSchema.safeParse({ ...body, folderId: 'f1' }).success).toBe(false)
  })

  it('has a stale body with the version now', () => {
    expect(
      staleErrorSchema.safeParse({ error: 'stale', message: 'The view has changed', version: 4 })
        .success,
    ).toBe(true)
  })
})

describe('neighbours (D67)', () => {
  it('defaults to depth 1, both directions, every relation and 100 nodes', () => {
    expect(neighboursQuerySchema.parse({})).toEqual({ depth: 1, direction: 'both', limit: 100 })
  })

  it('reads the query string', () => {
    expect(
      neighboursQuerySchema.parse({ depth: '2', direction: 'in', attributes: 'a,b', limit: '500' }),
    ).toEqual({ depth: 2, direction: 'in', attributes: ['a', 'b'], limit: 500 })
  })

  it.each([
    { depth: '0' },
    { depth: '3' },
    { direction: 'up' },
    { limit: '0' },
    { limit: String(MAX_NEIGHBOUR_NODES + 1) },
    { attributes: '' },
    { attributes: 'a,a' },
    { attributes: 'a,,b' },
    { attributes: Array.from({ length: 21 }, (_, i) => `a${String(i)}`).join(',') },
    { other: '1' },
  ])('refuses %j', (query) => {
    expect(neighboursQuerySchema.safeParse(query).success).toBe(false)
  })

  it('answers nodes with their depth, edges, truncated and hidden', () => {
    const body = {
      nodes: [
        { depth: 0, item },
        { depth: 1, item: { ...item, id: 'i2', seqId: 2 } },
      ],
      edges: [{ from: 'i1', attributeId: 'blocks', to: 'i2' }],
      truncated: false,
      hidden: 3,
      seq: 7,
    }
    expect(neighboursSchema.parse(body)).toEqual(body)
    expect(neighboursSchema.safeParse({ ...body, nodes: [] }).success).toBe(false)
    expect(neighboursSchema.safeParse({ ...body, hidden: 1001 }).success).toBe(false)
    expect(neighboursSchema.safeParse({ ...body, nodes: [{ depth: 3, item }] }).success).toBe(false)
  })
})

describe('search (D70)', () => {
  it('trims q and takes 2 to 200 characters, limit 1 to 50 (20 by default)', () => {
    expect(searchQuerySchema.parse({ q: '  parcel ' })).toEqual({ q: 'parcel', limit: 20 })
    expect(searchQuerySchema.parse({ q: 'ab', limit: '50', cursor: 'c' })).toEqual({
      q: 'ab',
      limit: 50,
      cursor: 'c',
    })
    for (const query of [
      { q: 'a' },
      { q: ' a ' },
      { q: 'a'.repeat(201) },
      { q: 'a\u0000b' },
      { q: 'ab', limit: '51' },
      { q: 'ab', limit: '0' },
      {},
    ]) {
      expect(searchQuerySchema.safeParse(query).success).toBe(false)
    }
  })

  it('answers a page of items with seq', () => {
    const body = { items: [item], nextCursor: null, seq: 3 }
    expect(searchResultSchema.parse(body)).toEqual(body)
  })
})

describe('hub templates (D71)', () => {
  const template = (): HubTemplateInput => ({
    format: HUB_TEMPLATE_FORMAT,
    version: 1,
    hub: {
      id: 'h1',
      name: 'Parcel Tracker',
      color: 'blue',
      idPrefix: 'PT',
      titleAttributeId: 'title',
      opensOnFolderId: 'home',
      attributes: [{ attributeId: 'title', required: true }],
    },
    folders: [
      {
        id: 'tasks',
        parentId: 'h1',
        name: 'Tasks',
        color: 'green',
        attributes: [{ attributeId: 'title' }, { attributeId: 'stage' }, { attributeId: 'deps' }],
      },
      { id: 'home', parentId: 'h1', name: 'Home', color: 'grey', viewsOnly: true },
      { id: 'done', parentId: 'tasks', name: 'Done', color: 'grey' },
    ],
    attributes: [
      { id: 'title', name: 'Title', type: 'text', config: {} },
      {
        id: 'stage',
        name: 'Stage',
        type: 'select',
        indexed: true,
        config: { options: [{ id: 'todo', label: 'To do', color: 'grey' }] },
      },
      {
        id: 'deps',
        name: 'Depends on',
        type: 'relation',
        config: { targetHubId: 'h1', crossHub: false, multiple: true },
      },
    ],
    views: [
      { folderId: 'home', tree: defaultViewTree('tasks', { viewsOnly: false }) },
      { folderId: 'tasks', tree: defaultViewTree('tasks', { viewsOnly: false }) },
    ],
  })

  const errors = (raw: unknown) => {
    const result = checkHubTemplate(raw)
    return result.ok ? [] : result.errors
  }

  it('reads a template that holds together, with its views parsed', () => {
    const result = checkHubTemplate(template())
    expect(result.ok).toBe(true)
    expect(result.ok && result.views.map((v) => v.folderId)).toEqual(['home', 'tasks'])
    expect(result.ok && result.template.attributes[0]).toMatchObject({ indexed: false })
  })

  it('refuses an unknown format or version', () => {
    expect(errors({ ...template(), version: 2 })).toEqual([
      { path: 'version', message: 'Only version 1 templates can be read' },
    ])
    expect(errors({ ...template(), format: 'other' })[0]?.path).toBe('format')
    expect(errors({ ...template(), items: [] })[0]?.message).toMatch(/items/)
  })

  it('refuses a relation pointing outside the template', () => {
    const t = template()
    t.attributes[2] = {
      id: 'deps',
      name: 'Depends on',
      type: 'relation',
      config: { targetHubId: 'other', crossHub: true },
    }
    expect(errors(t)).toEqual([
      {
        path: 'attributes.2.config',
        message: 'A template\'s relations target its own hub "h1" with crossHub off',
      },
    ])
  })

  it('needs parents listed first, unique IDs, and known references', () => {
    const t = template()
    const [tasks, home, done] = t.folders
    if (!tasks || !home || !done) throw new Error('three folders')
    t.folders = [done, tasks, { ...home, id: 'tasks' }]
    t.hub.titleAttributeId = 'stage'
    t.hub.attributes = [{ attributeId: 'nope' }]
    t.views = [{ folderId: 'gone', tree: {} }]
    expect(errors(t).map((e) => e.path)).toEqual([
      'hub.attributes.0.attributeId',
      'folders.0.parentId',
      'folders.2.id',
      'hub.titleAttributeId',
      'hub.opensOnFolderId',
      'views.0.folderId',
    ])
  })

  it('checks each view against the template, once per folder', () => {
    const t = template()
    t.views = [
      { folderId: 'tasks', tree: defaultViewTree('missing', { viewsOnly: false }) },
      { folderId: 'tasks', tree: defaultViewTree('tasks', { viewsOnly: false }) },
      { folderId: 'home', tree: { schemaVersion: 1 } },
    ]
    expect(errors(t).map((e) => e.path)).toEqual([
      'views.0.tree.root.children.0.config.binding.folderId',
      'views.1.folderId',
      'views.2.tree.root',
    ])
  })

  it('takes an import request with the hub fields to replace', () => {
    expect(importHubTemplateSchema.parse({ template: {}, idPrefix: 'PT2' })).toEqual({
      template: {},
      idPrefix: 'PT2',
    })
    expect(importHubTemplateSchema.safeParse({ template: {}, idPrefix: 'pt' }).success).toBe(false)
  })
})

describe('MCP tools (D88)', () => {
  const jsonSchema = (name: (typeof MCP_TOOL_NAMES)[number]) =>
    // The interface the MCP SDK v2 reads for `tools/list` (Standard JSON Schema).
    MCP_TOOLS[name].input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      type?: string
      properties?: Record<string, unknown>
    }

  it('lists the 12 wave 1 tools and the 6 later ones, once each', () => {
    expect(MCP_WAVE_1_TOOLS).toHaveLength(12)
    expect(MCP_LATER_TOOLS).toHaveLength(6)
    expect(new Set(MCP_TOOL_NAMES).size).toBe(18)
    expect(Object.keys(MCP_TOOLS).sort()).toEqual([...MCP_TOOL_NAMES].sort())
  })

  /** Every property name anywhere in a JSON Schema, nested operations included. */
  const propertyNames = (schema: unknown): string[] => {
    if (typeof schema !== 'object' || schema === null) return []
    const own = Object.entries(schema as Record<string, unknown>)
    return own.flatMap(([key, value]) => [
      ...(key === 'properties' && typeof value === 'object' && value !== null
        ? Object.keys(value)
        : []),
      ...propertyNames(value),
    ])
  }

  it.each(MCP_TOOL_NAMES)(
    '%s has a valid name and an object input with no workspace or hub',
    (name) => {
      expect(name).toMatch(/^[a-z][a-z_]{0,63}$/)
      const schema = jsonSchema(name)
      expect(schema.type).toBe('object')
      expect(propertyNames(schema)).not.toContain('workspaceId')
      expect(propertyNames(schema)).not.toContain('hubId')
      expect(MCP_TOOLS[name].description.length).toBeGreaterThan(20)
    },
  )

  it('marks reads read-only and lets every single-item write carry a mutation ID and cause', () => {
    for (const name of MCP_TOOL_NAMES) {
      const { annotations } = MCP_TOOLS[name]
      const properties = Object.keys(jsonSchema(name).properties ?? {})
      if (annotations.readOnlyHint) {
        expect(properties).not.toContain('clientMutationId')
      } else if (name !== 'batch_write') {
        expect(properties).toEqual(expect.arrayContaining(['clientMutationId', 'cause']))
      }
    }
    expect(MCP_TOOLS.create_item.annotations.destructiveHint).toBe(false)
    expect(MCP_TOOLS.delete_item.annotations.destructiveHint).toBe(true)
  })

  it('validates arguments with the route shapes', () => {
    const ok = (name: (typeof MCP_TOOL_NAMES)[number], args: unknown) =>
      MCP_TOOLS[name].input.safeParse(args).success
    expect(ok('describe_hub', {})).toBe(true)
    expect(ok('describe_hub', { hubId: 'h1' })).toBe(false)
    expect(ok('patch_item', { itemId: 'i1', version: 1, values: { a: 1 } })).toBe(true)
    // A patch changes something, as over HTTP.
    expect(ok('patch_item', { itemId: 'i1', version: 1 })).toBe(false)
    expect(ok('query_items', { from: 'f1' })).toBe(false)
    expect(ok('get_changes', { after: 0 })).toBe(true)
    expect(ok('get_changes', { after: '0' })).toBe(false)
    expect(ok('read_view', { folderId: 'f1', version: 0, blocks: ['b1'] })).toBe(true)
    expect(ok('neighbours', { itemId: 'i1', depth: 3 })).toBe(false)
    expect(ok('search', { q: 'x' })).toBe(false)
    expect(
      ok('claim_item', {
        itemId: 'i1',
        actorAttributeId: 'claimedBy',
        untilAttributeId: 'claimedUntil',
        duration: 'PT2H',
      }),
    ).toBe(true)
    expect(
      ok('claim_item', {
        itemId: 'i1',
        actorAttributeId: 'claimedBy',
        untilAttributeId: 'claimedUntil',
        duration: 'PT30S',
      }),
    ).toBe(false)
    expect(ok('batch_write', { operations: [{ op: 'delete', id: 'i1', version: 1 }] })).toBe(true)
    const upsert = { op: 'upsert', key: 'k', folderId: 'f1', values: {} }
    expect(ok('batch_write', { operations: [upsert] })).toBe(true)
    expect(ok('batch_write', { operations: [{ ...upsert, hubId: 'h1' }] })).toBe(false)
  })
})
