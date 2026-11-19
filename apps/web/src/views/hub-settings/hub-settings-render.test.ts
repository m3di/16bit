import type { AgentKey, HubDescription, HubGrantEntry, HubRole, Me } from '@16bit/core'
import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import type { Load } from '../home/useDashboard.ts'
import { fakeApi, json } from '../hub/fixtures.test-utils.ts'
import AttributeDialog from './AttributeDialog.vue'
import FolderAttributesDialog from './FolderAttributesDialog.vue'
import FolderDialog from './FolderDialog.vue'
import { description, HUB, meAs, WS } from './fixtures.test-utils.ts'
import HubSettingsPage from './HubSettingsPage.vue'
import { SECTION_PATHS, SECTION_ROUTES, type HubSettingsSection } from './schema.ts'
import { useHubAccess, type HubAccess } from './useHubAccess.ts'
import { useHubSettings } from './useHubSettings.ts'

// What each reader is offered, and every page state. Key handling and the write flows in a
// real browser are in e2e/tests/hub-settings.spec.ts; the flows' API calls in
// useHubSettings.test.ts.

const hubPath = `/v1/workspaces/${WS}/hubs/${HUB}`

async function storeWith(answer: () => Response, load = true) {
  const { fetchFn } = fakeApi((call) =>
    call.path === hubPath ? answer() : json({ error: 'not_found', message: 'x' }, 404),
  )
  const model = useHubSettings(WS, HUB, fetchFn)
  if (load) await model.load()
  return model
}

async function renderIn(component: Component, props: Record<string, unknown>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/hubs/:hubId/:folderId?',
        name: 'hub',
        component: { render: () => null },
      },
      ...(Object.keys(SECTION_ROUTES) as HubSettingsSection[]).map((section) => ({
        path: `/w/:workspaceId/hubs/:hubId/settings/${SECTION_PATHS[section]}`,
        name: SECTION_ROUTES[section],
        component: { render: () => null },
      })),
    ],
  })
  await router.push(`/w/${WS}/hubs/${HUB}/settings/folders`)
  return renderToString(createSSRApp({ render: () => h(component, props) }).use(router))
}

async function renderPage(
  options: {
    role?: HubRole
    me?: Load<Me | null>
    section?: HubSettingsSection
    hub?: () => Response
    load?: boolean
    data?: HubDescription
    access?: HubAccess
  } = {},
) {
  const data = options.data ?? description(options.role ?? 'hub_admin')
  const model = await storeWith(options.hub ?? (() => json(data)), options.load !== false)
  const me = options.me ?? { state: 'ready', data: meAs('member') }
  const access = options.access ?? useHubAccess(WS, HUB, fakeApi(() => json({}, 500)).fetchFn)
  return renderIn(HubSettingsPage, {
    workspaceId: WS,
    hubId: HUB,
    section: options.section ?? 'folders',
    model,
    access,
    me,
  })
}

const rowMenus = (html: string) =>
  [...html.matchAll(/aria-label="Actions for ([^"]+)"/g)].map((m) => m[1])

describe('HubSettingsPage, folders', () => {
  it('shows the hub and its folders as a tree with item and attribute counts', async () => {
    const html = await renderPage()
    expect(html).toContain('Parcel Tracker / Build / Hub settings')
    expect(html).toContain('Back to Build')
    expect(html).toMatch(/aria-current="page"[^>]*>Folders</)
    expect(html).toContain('>Attributes</a>')
    const rows = [...html.matchAll(/data-folder-id="([^"]+)"/g)].map((m) => m[1])
    expect(rows).toEqual([HUB, 'backlog', 'sprints', 'sprint-1'])
    expect(html).toContain('padding-left:32px')
  })

  it('offers a hub admin New folder and a menu on every row', async () => {
    const html = await renderPage()
    expect(html).toContain('data-new-folder')
    expect(rowMenus(html)).toEqual(['Build', 'Backlog', 'Sprints', 'Sprint 1'])
  })

  it('shows an editor the same list read-only, with the reason in words', async () => {
    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      const html = await renderPage({ role })
      expect(html, role).toContain('Only hub admins can change folders and attributes.')
      expect(html, role).not.toContain('data-new-folder')
      expect(rowMenus(html), role).toEqual([])
      expect(html, role).toContain('data-folder-id="backlog"')
    }
  })

  it('an owner without hub_admin on this hub cannot change it either', async () => {
    const html = await renderPage({ role: 'editor', me: { state: 'ready', data: meAs('owner') } })
    expect(html).not.toContain('data-new-folder')
  })

  it('says when the hub has no folders yet', async () => {
    const data = { ...description(), folders: [] }
    const html = await renderPage({ data })
    expect(html).toContain('data-folders-empty')
  })
})

describe('HubSettingsPage, attributes', () => {
  it('lists attributes with type, folders and filter flag; the type is text, not a control', async () => {
    const html = await renderPage({ section: 'attributes' })
    expect(html).toMatch(/aria-current="page"[^>]*>Attributes</)
    const rows = [...html.matchAll(/data-attribute-id="([^"]+)"/g)].map((m) => m[1])
    expect(rows).toEqual(['points', 'stage', 'title'])
    expect(html).toContain('Build, Backlog')
    expect(html).toContain('No folder')
    expect(html).toContain('>Title</span>')
    expect(html).toContain('data-new-attribute')
    expect(rowMenus(html)).toEqual(['Points', 'Stage', 'Title'])
  })

  it('read-only for anyone but hub admins', async () => {
    const html = await renderPage({ section: 'attributes', role: 'editor' })
    expect(html).not.toContain('data-new-attribute')
    expect(rowMenus(html)).toEqual([])
  })

  it('has an empty state that offers the first attribute', async () => {
    const data = { ...description(), attributes: [], folderAttributes: [] }
    const html = await renderPage({ section: 'attributes', data })
    expect(html).toContain('No attributes yet')
    expect(html).toContain('data-new-attribute')
  })
})

describe('HubSettingsPage states', () => {
  it('loading', async () => {
    const html = await renderPage({ load: false })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('data-folder-row')
  })

  it('not found hides the hub name and the section nav (D45)', async () => {
    const html = await renderPage({
      hub: () => json({ error: 'not_found', message: 'Hub not found' }, 404),
    })
    expect(html).toContain('This hub is not available')
    expect(html).toContain('Parcel Tracker / Hub settings')
    expect(html).toContain('Back to hubs')
    expect(html).not.toContain('Build')
    expect(html).not.toContain('aria-label="Hub settings"')
  })

  it('error keeps the nav and offers a retry', async () => {
    const html = await renderPage({ hub: () => json({ error: 'internal', message: 'Boom' }, 500) })
    expect(html).toContain('The hub could not be loaded')
    expect(html).toContain('Try again')
    expect(html).toContain('aria-label="Hub settings"')
  })

  it('a session that failed is an error, an agent has no permission', async () => {
    const failed = await renderPage({
      me: { state: 'error', error: new ApiRequestError('network', 'Offline') },
    })
    expect(failed).toContain('The hub could not be loaded')
    const agent: Me = {
      kind: 'agent',
      principalId: 'p-bot',
      workspace: { id: WS, name: 'Parcel Tracker' },
      hub: { id: HUB, name: 'Build' },
      hubRole: 'editor',
    }
    const html = await renderPage({ me: { state: 'ready', data: agent } })
    expect(html).toContain('You do not have access to this')
  })
})

describe('FolderDialog', () => {
  it('edits name, colour and place; never offers the folder or one under it as the parent', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(FolderDialog, {
      open: true,
      description: description(),
      folderId: 'sprints',
      model,
    })
    expect(html).toContain('Edit Sprints')
    expect(html).toMatch(/value="Sprints"/)
    const parents = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    expect(parents).toEqual([HUB, 'backlog'])
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('Save folder')
  })

  it('creates inside the folder it was opened from', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(FolderDialog, {
      open: true,
      description: description(),
      folderId: null,
      parentId: 'sprints',
      model,
    })
    expect(html).toContain('New folder')
    expect(html).toMatch(/<option value="sprints" selected/)
    expect(html).toContain('Create folder')
  })
})

describe('FolderAttributesDialog', () => {
  it('lists the attributes in order with their required switches, and offers the rest', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(FolderAttributesDialog, {
      open: true,
      description: description(),
      folderId: 'backlog',
      model,
    })
    expect(html).toContain('Attributes in Backlog')
    const rows = [...html.matchAll(/data-attribute-id="([^"]+)"/g)].map((m) => m[1])
    expect(rows).toEqual(['title', 'stage'])
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Title is required"/)
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Stage is required"/)
    expect(html).toContain('Points (Number)')
    expect(html).not.toContain('Stage (Select)')
  })

  it('a folder that is gone is not found', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(FolderAttributesDialog, {
      open: true,
      description: description(),
      folderId: 'gone',
      model,
    })
    expect(html).toContain('This folder is not available')
    expect(html).not.toContain('data-attr-row')
  })
})

describe('AttributeDialog', () => {
  it('a new attribute offers every type', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(AttributeDialog, {
      open: true,
      description: description(),
      attributeId: null,
      model,
    })
    expect(html).toContain('New attribute')
    expect((html.match(/type="radio"/g) ?? []).length).toBe(11)
    expect(html).toContain('Create attribute')
  })

  it('an existing select shows its type locked and its options editable (D51)', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(AttributeDialog, {
      open: true,
      description: description(),
      attributeId: 'stage',
      model,
    })
    expect(html).toContain('Edit Stage')
    expect(html).toContain('data-state="locked"')
    expect(html).toContain('The type cannot change once the attribute exists.')
    expect(html).not.toContain('type="radio"')
    expect(html).toMatch(/value="To do"/)
    expect(html).toMatch(/value="Done"/)
    expect(html).toContain('Filter and sort: on')
  })

  it('names the title attribute as such', async () => {
    const model = await storeWith(() => json(description()))
    const html = await renderIn(AttributeDialog, {
      open: true,
      description: description(),
      attributeId: 'title',
      model,
    })
    expect(html).toContain('data-title-note')
    expect(html).not.toContain('Add option')
  })
})

// ---- general, access, agent keys, danger zone (#116) ------------------------------------

const grantRows = (): HubGrantEntry[] => [
  {
    principalId: 'bot',
    kind: 'agent',
    name: 'qa-agent',
    workspaceRole: 'member',
    hubRole: 'editor',
    keyState: 'active',
  },
  { principalId: 'ivy', kind: 'user', name: 'Ivy', workspaceRole: 'viewer', hubRole: 'editor' },
  { principalId: 'own', kind: 'user', name: 'Olga', workspaceRole: 'owner', hubRole: 'viewer' },
  {
    principalId: 'p-sara',
    kind: 'user',
    name: 'Sara',
    workspaceRole: 'member',
    hubRole: 'hub_admin',
  },
  { principalId: 'tomas', kind: 'user', name: 'Tomas', workspaceRole: 'member', hubRole: 'editor' },
]

const keyRows = (): AgentKey[] => [
  {
    workspaceId: WS,
    id: 'bot',
    name: 'qa-agent',
    hubId: HUB,
    hubRole: 'editor',
    createdBy: 'p-sara',
    createdAt: '2026-11-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
  },
  {
    workspaceId: WS,
    id: 'old',
    name: 'old-agent',
    hubId: HUB,
    hubRole: 'viewer',
    createdBy: 'gone',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: '2026-10-02T00:00:00.000Z',
  },
]

/** An access store with every list answered, or failing with `fail`. */
async function accessWith(fail?: Response) {
  const { fetchFn } = fakeApi((call) => {
    if (fail) return fail.clone()
    if (call.path.includes('/grants?')) return json({ items: grantRows(), nextCursor: null })
    if (call.path.includes('/agent-keys?')) return json({ items: keyRows(), nextCursor: null })
    if (call.path.includes('/members?'))
      return json({
        items: [
          { workspaceId: WS, id: 'p-sara', kind: 'user', name: 'Sara', workspaceRole: 'member' },
        ],
        nextCursor: null,
      })
    return json({ error: 'not_found', message: 'x' }, 404)
  })
  const access = useHubAccess(WS, HUB, fetchFn)
  await Promise.all([access.loadGrants(), access.loadKeys(), access.loadMembers()])
  return access
}

describe('HubSettingsPage, nav', () => {
  it('lists every section in order, the danger zone marked', async () => {
    const html = await renderPage({ section: 'general' })
    const labels = [
      ...html.matchAll(/<a [^>]*href="[^"]*\/settings\/[^"]*"[^>]*>([^<]+)<\/a>/g),
    ].map((m) => m[1])
    expect(labels).toEqual([
      'General',
      'Access',
      'Folders',
      'Attributes',
      'Agent keys',
      'Danger zone',
    ])
    expect(html).toMatch(/aria-current="page"[^>]*>General</)
    expect(html).toMatch(/class="[^"]*text-danger[^"]*"[^>]*>Danger zone</)
  })
})

describe('HubSettingsPage, general', () => {
  it('a hub admin edits name, colour and title; the item total counts every folder', async () => {
    const html = await renderPage({ section: 'general' })
    expect(html).toContain('data-hub-name')
    expect(html).toContain('value="Build"')
    expect(html).toContain('5 items in this hub, counting every folder.')
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('data-title-attribute')
    expect(html).toMatch(/<option value="title"[^>]*selected/)
    // Only text attributes can title items (D50).
    expect(html).not.toMatch(/<option value="stage"/)
    expect(html).toContain('All changes saved')
  })

  it('anyone else sees the values read-only, with the reason', async () => {
    for (const [role, ws] of [
      ['editor', 'member'],
      ['viewer', 'viewer'],
      ['editor', 'owner'],
    ] as const) {
      const html = await renderPage({
        section: 'general',
        role,
        me: { state: 'ready', data: meAs(ws) },
      })
      expect(html, role).toContain('data-general-read-only')
      expect(html, role).not.toContain('data-hub-name')
      expect(html, role).toContain('Only hub admins can rename this hub')
      expect(html, role).toContain('Title')
      expect(html, role).toContain('Teal')
    }
  })
})

describe('HubSettingsPage, access', () => {
  it('a hub admin changes members only; agents, owners and themselves are locked', async () => {
    const access = await accessWith()
    const html = await renderPage({ section: 'access', access })
    expect(html).toContain('data-add-access')
    expect(html).toContain('>Hub role for Tomas</label>')
    expect(html).toContain('>Hub role for Ivy</label>')
    expect(html).not.toContain('>Hub role for Sara</label>')
    expect(html).not.toContain('>Hub role for Olga</label>')
    expect(html).not.toContain('>Hub role for qa-agent</label>')
    expect(html).toContain('Set by its key')
    expect(html).toContain('Only owners change owners')
    expect(html).toContain('Your own access')
    // A viewer of the workspace acts as viewer whatever the grant.
    expect(html).toContain('Acts as viewer')
    expect(rowMenus(html)).toEqual(['Ivy', 'Tomas'])
    expect(html).toContain('Agent key<')
  })

  it('an editor cannot see who has access', async () => {
    const access = await accessWith()
    const html = await renderPage({ section: 'access', role: 'editor', access })
    expect(html).toContain('You cannot see who has access')
    expect(html).not.toContain('data-grant-row')
    expect(html).not.toContain('data-add-access')
  })

  it('an owner with a viewer grant changes everyone but agents, themselves included', async () => {
    const access = await accessWith()
    const html = await renderPage({
      section: 'access',
      role: 'viewer',
      access,
      me: { state: 'ready', data: meAs('owner') },
    })
    expect(html).toContain('>Hub role for Sara</label>')
    expect(html).toContain('>Hub role for Olga</label>')
    expect(html).not.toContain('>Hub role for qa-agent</label>')
    expect(rowMenus(html)).toEqual(['Ivy', 'Olga', 'Sara', 'Tomas'])
  })

  it('an admin cannot touch an owner’s grant (¹)', async () => {
    const access = await accessWith()
    const html = await renderPage({
      section: 'access',
      role: 'editor',
      access,
      me: { state: 'ready', data: meAs('admin') },
    })
    expect(html).not.toContain('>Hub role for Olga</label>')
    expect(rowMenus(html)).not.toContain('Olga')
  })

  it('loading and error states', async () => {
    const loading = useHubAccess(WS, HUB, fakeApi(() => json({}, 500)).fetchFn)
    expect(await renderPage({ section: 'access', access: loading })).toContain(
      'Loading who has access',
    )
    const failed = await accessWith(json({ error: 'internal', message: 'Boom' }, 500))
    const html = await renderPage({ section: 'access', access: failed })
    expect(html).toContain('Who has access could not be loaded')
    expect(html).toContain('Try again')
  })
})

describe('HubSettingsPage, agent keys', () => {
  it('a hub admin lists keys with creator, status, and revokes active ones', async () => {
    const access = await accessWith()
    const html = await renderPage({ section: 'keys', access })
    expect(html).toContain('data-new-key')
    expect(html).toContain('qa-agent')
    expect(html).toContain('Active')
    expect(html).toContain('Revoked')
    expect((html.match(/data-revoke-key/g) ?? []).length).toBe(1)
    // A creator missing from the member list shows as a short ID, never a made-up name.
    expect(html).toContain('name not available')
  })

  it('an editor cannot see the keys', async () => {
    const access = await accessWith()
    const html = await renderPage({ section: 'keys', role: 'editor', access })
    expect(html).toContain('You cannot see this hub’s agent keys')
    expect(html).not.toContain('data-key-row')
  })

  it('says when there are none', async () => {
    const { fetchFn } = fakeApi(() => json({ items: [], nextCursor: null }))
    const access = useHubAccess(WS, HUB, fetchFn)
    await access.loadKeys()
    const html = await renderPage({ section: 'keys', access })
    expect(html).toContain('No agent keys yet')
    // The first key can be made from the empty state.
    expect(html).toContain('data-new-key')
  })
})

describe('HubSettingsPage, danger zone', () => {
  const empty = (): HubDescription => ({
    ...description(),
    hub: { ...description().hub, itemCount: 0 },
    folders: [],
  })

  it('an owner deletes an empty hub', async () => {
    const access = await accessWith()
    const html = await renderPage({
      section: 'danger',
      data: empty(),
      access,
      me: { state: 'ready', data: meAs('owner') },
    })
    const button = /<button[^>]*data-delete-hub[^>]*>/.exec(html)?.[0] ?? ''
    expect(button).not.toBe('')
    expect(button).not.toMatch(/\sdisabled(=""|\s|>)/)
    expect(html).not.toContain('data-delete-refused')
  })

  it('a hub that holds items or folders says so', async () => {
    const html = await renderPage({
      section: 'danger',
      me: { state: 'ready', data: meAs('owner') },
    })
    expect(html).toContain('It still holds 5 items and 3 folders.')
    expect(/<button[^>]*data-delete-hub[^>]*>/.exec(html)?.[0]).toMatch(/\sdisabled(=""|\s|>)/)
  })

  it('an admin is refused while an owner holds a grant; a member always', async () => {
    const access = await accessWith()
    const admin = await renderPage({
      section: 'danger',
      data: empty(),
      access,
      me: { state: 'ready', data: meAs('admin') },
    })
    expect(admin).toContain('only an owner can delete it')
    const member = await renderPage({ section: 'danger', data: empty(), access })
    expect(member).toContain('Only workspace owners and admins delete hubs.')
  })
})
