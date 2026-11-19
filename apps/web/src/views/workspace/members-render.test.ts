import type { Me, WorkspaceRole } from '@16bit/core'
import { createSSRApp, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { json } from '../../session/fixtures.test-utils.ts'
import type { Load } from '../home/useDashboard.ts'
import { fakeApi, invite, meAs, people, WS, type Handler } from './fixtures.test-utils.ts'
import MembersPage from './MembersPage.vue'
import { useWorkspaceMembers } from './useWorkspaceMembers.ts'

// One render per role (docs/ROLES.md, workspace table): which controls each reader gets.
// Key handling of the shared controls is covered in ui/ and e2e; here it is what is offered.

const base = `/v1/workspaces/${WS}`
const page = (items: unknown[]) => json({ items, nextCursor: null })

const defaultRoutes: Record<string, Handler> = {
  [`GET ${base}/members`]: () => page(people),
  [`GET ${base}/invites`]: () =>
    page([invite('i1', 'member', 'p-priya'), invite('i2', 'owner', 'p-gone')]),
}

async function renderPage(
  me: Load<Me | null>,
  routes: Record<string, Handler> = {},
  options: { load?: boolean } = {},
) {
  const { fetchFn } = fakeApi({ ...defaultRoutes, ...routes })
  const model = useWorkspaceMembers(WS, () => (me.state === 'ready' ? me.data : null), fetchFn)
  if (options.load !== false) await model.load()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/settings/members',
        name: 'workspace-members',
        component: { render: () => null },
      },
    ],
  })
  await router.push(`/w/${WS}/settings/members`)
  const app = createSSRApp({
    render: () => h(MembersPage, { workspaceId: WS, model, me, origin: 'https://16bit.example' }),
  }).use(router)
  return renderToString(app)
}

const ready = (principalId: string, role: WorkspaceRole): Load<Me | null> => ({
  state: 'ready',
  data: meAs(principalId, role),
})

const selects = (html: string) => [...html.matchAll(/aria-label="Actions for ([^"]+)"/g)]
const roleSelects = (html: string) =>
  [...html.matchAll(/<label [^>]*>Role for ([^<]+)<\/label>/g)].map((m) => m[1])
const menus = (html: string) => selects(html).map((m) => m[1])

describe('MembersPage as an owner', () => {
  it('lets the owner change every other role and remove anyone but the only owner', async () => {
    const html = await renderPage(ready('p-sara', 'owner'))
    expect(html).toContain('Members and roles')
    expect(html).toContain('You own this workspace.')
    expect(html).toContain('Parcel Tracker / Workspace settings')
    expect(html).toContain('aria-current="page"')
    expect(roleSelects(html)).toEqual(['Priya', 'Tomas', 'Omar'])
    // The only owner is read-only, with the reason in words.
    expect(html).toMatch(/data-role-text[^>]*><span>Owner<\/span><span[^>]*>The only owner</)
    expect(menus(html)).toEqual(['Sara', 'Priya', 'Tomas', 'Omar'])
    // The owner's role select offers Owner.
    expect(html).toMatch(/<option value="owner"/)
    expect(html).toContain('>Invite people<')
    expect(html).toContain('4 people, 2 invites pending')
  })

  it('lists pending invites with a revoke button each and a creator', async () => {
    const html = await renderPage(ready('p-sara', 'owner'))
    expect(html).toContain('Pending invites')
    expect(html.match(/data-invite-row/g)).toHaveLength(2)
    expect(html.match(/data-revoke/g)).toHaveLength(2)
    expect(html).toContain('Priya')
    // A creator who is no longer a member shows a short ID, never a name.
    expect(html).toContain('name not available')
    expect(html).toContain('Nov 14')
    // Invites have no token after creation: no link is ever listed.
    expect(html).not.toContain('/invite/')
  })

  it('shows the empty invites state', async () => {
    const html = await renderPage(ready('p-sara', 'owner'), {
      [`GET ${base}/invites`]: () => page([]),
    })
    expect(html).toContain('No pending invites')
    expect(html).toContain('4 people<')
  })

  it('shows an invite load error with a retry and keeps the people', async () => {
    const html = await renderPage(ready('p-sara', 'owner'), {
      [`GET ${base}/invites`]: () => json({ error: 'internal', message: 'Boom' }, 500),
    })
    expect(html).toContain('The invites could not be loaded')
    expect(html).toContain('Try again')
    expect(roleSelects(html)).toHaveLength(3)
  })
})

describe('MembersPage as an admin', () => {
  it('shows owners read-only and never offers the owner role', async () => {
    const html = await renderPage(ready('p-priya', 'admin'))
    expect(html).toContain('You are an admin of this workspace.')
    expect(roleSelects(html)).toEqual(['Priya', 'Tomas', 'Omar'])
    expect(html).not.toMatch(/<option value="owner"/)
    expect(html).toContain('Only owners change owners')
    // No actions on the owner's row.
    expect(menus(html)).toEqual(['Priya', 'Tomas', 'Omar'])
  })

  it('cannot revoke an owner-role invite', async () => {
    const html = await renderPage(ready('p-priya', 'admin'))
    expect(html.match(/data-revoke/g)).toHaveLength(1)
    expect(html).toContain('Only owners revoke')
  })
})

describe('MembersPage as a member, viewer or finance', () => {
  it.each([
    ['p-tomas', 'member'],
    ['p-omar', 'viewer'],
    ['p-omar', 'finance'],
  ] as const)('%s as %s sees the read-only list and no invites', async (id, role) => {
    const html = await renderPage(ready(id, role), {
      [`GET ${base}/members`]: () =>
        page(people.map((p) => (p.id === id ? { ...p, workspaceRole: role } : p))),
    })
    expect(html).toContain('Only owners and admins change roles and invite people.')
    expect(roleSelects(html)).toEqual([])
    expect(menus(html)).toEqual([])
    expect(html).not.toContain('Invite people')
    expect(html).not.toContain('Pending invites')
    expect(html).not.toContain('Only owners change owners')
    for (const name of ['Sara', 'Priya', 'Tomas', 'Omar']) expect(html).toContain(name)
    expect(html.match(/data-member-row/g)).toHaveLength(4)
    expect(html).toMatch(/>You</)
  })
})

describe('MembersPage states', () => {
  it('loads', async () => {
    const html = await renderPage({ state: 'loading' }, {}, { load: false })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('data-member-row')
  })

  it('says a workspace that answers 404 is not available, without its name', async () => {
    const html = await renderPage(ready('p-sara', 'owner'), {
      [`GET ${base}/members`]: () =>
        json({ error: 'not_found', message: 'Workspace not found' }, 404),
    })
    expect(html).toContain('This workspace is not available')
    expect(html).not.toContain('Parcel Tracker')
    expect(html).not.toContain('aria-label="Workspace settings"')
    expect(html).toContain('Back to hubs')
  })

  it('refuses an agent key', async () => {
    const agent: Me = {
      kind: 'agent',
      principalId: 'a1',
      workspace: { id: WS, name: 'Parcel Tracker' },
      hub: { id: 'h', name: 'Hub' },
      hubRole: 'editor',
    }
    const html = await renderPage(
      { state: 'ready', data: agent },
      {
        [`GET ${base}/members`]: () => json({ error: 'forbidden', message: 'No' }, 403),
      },
    )
    expect(html).toContain('data-state="no-permission"')
    expect(html).toContain('Agent keys cannot see a workspace’s members.')
    expect(html).not.toContain('data-member-row')
  })

  it('gives a person refused the list a generic reason, not the agent one', async () => {
    const html = await renderPage(ready('p-tomas', 'member'), {
      [`GET ${base}/members`]: () => json({ error: 'forbidden', message: 'No' }, 403),
    })
    expect(html).toContain('data-state="no-permission"')
    expect(html).toContain('Your role does not let you see this workspace’s members.')
    expect(html).not.toContain('Agent keys')
  })

  it('shows an error with a retry', async () => {
    const html = await renderPage(ready('p-sara', 'owner'), {
      [`GET ${base}/members`]: () => json({ error: 'internal', message: 'Boom' }, 500),
    })
    expect(html).toContain('The members could not be loaded')
    expect(html).toContain('Boom')
    expect(html).toContain('Try again')
  })

  it('shows a session error', async () => {
    const html = await renderPage(
      { state: 'error', error: new ApiRequestError('network', 'Unreachable') },
      {},
      { load: false },
    )
    expect(html).toContain('Unreachable')
  })
})
