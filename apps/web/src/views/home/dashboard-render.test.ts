import type { HubListEntry } from '@16bit/core'
import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import AppShell from '../../ui/AppShell.vue'
import HubCard from '../../ui/HubCard.vue'
import type { WorkspaceEntry } from './useDashboard.ts'
import NewHubDialog from './NewHubDialog.vue'
import WorkspaceSection from './WorkspaceSection.vue'

const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/w/:workspaceId/hubs/:hubId/:folderId?',
        name: 'hub',
        component: { render: () => null },
      },
      {
        path: '/w/:workspaceId/settings/members',
        name: 'workspace-members',
        component: { render: () => null },
      },
      {
        path: '/w/:workspaceId/hubs/:hubId/settings/general',
        name: 'hub-settings-general',
        component: { render: () => null },
      },
    ],
  })

const render = async (c: Component, props: Record<string, unknown> = {}) => {
  const r = router()
  const app = createSSRApp({ render: () => h(c, props) }).use(r)
  await r.push('/')
  await r.isReady()
  return renderToString(app)
}

const hub: HubListEntry = {
  access: 'granted',
  hubRole: 'editor',
  workspaceId: 'w',
  id: 'eng',
  hubId: 'eng',
  parentId: null,
  name: 'Engineering',
  color: 'teal',
  idPrefix: 'ENG',
  itemCount: 1280,
  version: 1,
}

const hidden: HubListEntry = {
  access: 'none',
  workspaceId: 'w',
  id: 'fin',
  name: 'Finance',
  color: 'amber',
}

const entry = (hubs: WorkspaceEntry['hubs']): WorkspaceEntry => ({
  workspace: { id: 'w', name: 'Parcel Tracker', createdAt: '2026-11-16T00:00:00.000Z' },
  hubs,
})

describe('HubCard', () => {
  it('shows the colour, name, size, and count', async () => {
    const html = await render(HubCard, { name: 'Engineering', color: 'teal', count: 1280 })
    expect(html).toContain('var(--pal-teal)')
    expect(html).toContain('Engineering')
    expect(html).toContain('aria-label="Size: 4 of 4"')
    expect(html).toContain('1,280 items')
    expect(html).toMatch(/^<div/)
  })

  it('says one item in the singular', async () => {
    expect(await render(HubCard, { name: 'A', color: 'teal', count: 1 })).toContain('1 item<')
  })

  it('is a link when it has a destination', async () => {
    const html = await render(HubCard, {
      name: 'A',
      color: 'teal',
      count: 0,
      to: { name: 'hub', params: { workspaceId: 'w', hubId: 'eng' } },
    })
    expect(html).toMatch(/^<a [^>]*href="\/w\/w\/hubs\/eng"/)
  })

  it('shows name and "No access" only without access, and is never a link', async () => {
    const html = await render(HubCard, {
      name: 'Finance',
      color: 'amber',
      count: 12,
      to: { name: 'hub', params: { workspaceId: 'w', hubId: 'fin' } },
      noAccess: true,
    })
    expect(html).toMatch(/^<div/)
    expect(html).not.toContain('href=')
    expect(html).toContain('data-no-access')
    expect(html).toContain('var(--pal-amber)')
    expect(html).toContain('Finance')
    expect(html).toContain('No access')
    expect(html).not.toContain('Size:')
    expect(html).not.toMatch(/\d items?</)
  })

  it('types its props so only a card with access takes a count and a link', () => {
    // Checked by `pnpm typecheck`; the calls only build vnodes.
    h(HubCard, { name: 'A', color: 'teal', count: 3, to: '/w/w/hubs/a' })
    h(HubCard, { name: 'A', color: 'teal', noAccess: true })
    // @ts-expect-error A card with access needs its count.
    h(HubCard, { name: 'A', color: 'teal' })
    // @ts-expect-error A no-access card shows no count.
    h(HubCard, { name: 'A', color: 'teal', noAccess: true, count: 3 })
    // @ts-expect-error A no-access card is never a link.
    h(HubCard, { name: 'A', color: 'teal', noAccess: true, to: '/w/w/hubs/a' })
  })

  it('reads the bare no-access attribute as true', async () => {
    const html = await render(HubCard, { name: 'Finance', color: 'amber', 'no-access': '' })
    expect(html).toContain('data-no-access')
    expect(html).toContain('No access')
  })

  it('has no "No access" marker when the reader has access', async () => {
    const html = await render(HubCard, { name: 'A', color: 'teal', count: 3 })
    expect(html).not.toContain('data-no-access')
    expect(html).not.toContain('No access')
  })
})

describe('AppShell', () => {
  it('has the brand linking home and a theme control', async () => {
    const html = await render(AppShell)
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>[\s\S]*16bit\.info/)
    expect(html).toContain('<select')
  })
})

describe('WorkspaceSection', () => {
  it('lists hubs as cards under the workspace name', async () => {
    const html = await render(WorkspaceSection, { entry: entry({ state: 'ready', data: [hub] }) })
    expect(html).toContain('aria-labelledby="workspace-w"')
    expect(html).toContain('<h2 id="workspace-w"')
    expect(html).toContain('Parcel Tracker')
    expect(html.match(/data-hub-card/g)).toHaveLength(1)
    expect(html).toMatch(/<a [^>]*href="\/w\/w\/hubs\/eng"/)
  })

  it('links to the workspace members page, named with the workspace', async () => {
    const states: WorkspaceEntry['hubs'][] = [{ state: 'ready', data: [] }, { state: 'loading' }]
    for (const hubs of states) {
      const html = await render(WorkspaceSection, { entry: entry(hubs) })
      expect(html).toMatch(
        /<a [^>]*href="\/w\/w\/settings\/members"[^>]*>Members and roles<span class="sr-only"> of Parcel Tracker<\/span><\/a>/,
      )
    }
  })

  it('shows hubs without a grant as "no access" cards next to the others', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hub, hidden] }),
    })
    expect(html.match(/data-hub-card/g)).toHaveLength(2)
    expect(html.match(/data-no-access/g)).toHaveLength(1)
    expect(html.match(/<a [^>]*href="\/w\/w\/hubs\//g)).toHaveLength(1)
    expect(html).toContain('1,280 items')
    expect(html).toContain('Finance')
    expect(html).toContain('No access')
    expect(html).not.toContain('/hubs/fin')
    // Without a reader who may self-grant or manage, the cards offer nothing else.
    expect(html).not.toContain('<button')
    expect(html).not.toContain('data-hub-settings')
  })

  const states: [string, WorkspaceEntry['hubs'], string][] = [
    ['loading', { state: 'loading' }, 'role="status"'],
    ['empty', { state: 'ready', data: [] }, 'No hubs yet'],
    [
      'error',
      { state: 'error', error: new ApiRequestError('internal', 'Internal error', 500) },
      'role="alert"',
    ],
    [
      'no permission',
      { state: 'error', error: new ApiRequestError('unauthorized', 'No', 401) },
      'You do not have access',
    ],
    [
      'forbidden',
      { state: 'error', error: new ApiRequestError('forbidden', 'No', 403) },
      'You do not have access',
    ],
    [
      'not found',
      { state: 'error', error: new ApiRequestError('not_found', 'Gone', 404) },
      'This workspace is not available',
    ],
  ]
  it.each(states)('renders the %s state', async (_name, hubs, expected) => {
    const html = await render(WorkspaceSection, { entry: entry(hubs) })
    expect(html).toContain(expected)
    expect(html).not.toContain('data-hub-card')
  })

  it('offers a retry on error', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'error', error: new ApiRequestError('network', 'Unreachable') }),
    })
    expect(html).toContain('Try again')
    expect(html).toContain('Unreachable')
  })
})

describe('WorkspaceSection self-grant', () => {
  it('offers owners and admins access to a "no access" hub, named for screen readers', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hub, hidden] }),
      canSelfGrant: true,
    })
    expect(html).toContain('Give myself access')
    expect(html).toContain('to Finance')
    expect((html.match(/data-self-grant(?!-)/g) ?? []).length).toBe(1)
  })

  it('offers nothing to others', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hidden] }),
    })
    expect(html).not.toContain('Give myself access')
  })

  it('shows a self-grant on its way and one that was refused', async () => {
    const busy = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hidden] }),
      canSelfGrant: true,
      selfGrants: new Map([['w/fin', { state: 'busy' }]]),
    })
    expect(busy).toContain('Giving access')
    const refused = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hidden] }),
      canSelfGrant: true,
      selfGrants: new Map([['w/fin', { state: 'error', message: 'Access was not given. Boom' }]]),
    })
    expect(refused).toContain('data-self-grant-error')
    expect(refused).toContain('Access was not given. Boom')
    expect(refused).toContain('role="alert"')
  })

  it('says when access was given but the hubs did not load again, and offers to load them', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hidden] }),
      canSelfGrant: true,
      selfGrants: new Map([['w/fin', { state: 'stale' }]]),
    })
    expect(html).toContain('data-self-grant-stale')
    // The failure comes first: the notice is an error.
    expect(html).toContain('The hubs could not be loaded again. You now have access to Finance;')
    expect(html).toContain('Load hubs again')
    expect(html).toContain('role="alert"')
    // Granting again would change nothing: the offer waits for the list.
    expect(html).not.toContain('Give myself access')
  })
})

describe('WorkspaceSection hub settings link (issue 240)', () => {
  const as = (workspaceRole: 'owner' | 'admin' | 'member' | 'viewer') =>
    ({ id: 'p', kind: 'user', workspaceRole }) as const
  const settingsLink = (hubId: string, name: string) =>
    new RegExp(
      `<a [^>]*href="/w/w/hubs/${hubId}/settings/general"[^>]*aria-label="Settings for ${name}"`,
    )

  it('links owners to a hub’s General settings, outside the card link', async () => {
    const html = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [hub, hidden] }),
      canSelfGrant: true,
      viewer: as('owner'),
    })
    expect(html).toMatch(settingsLink('eng', 'Engineering'))
    // One link per hub the reader may manage; a hub without a grant has no settings to open.
    expect(html.match(/data-hub-settings/g)).toHaveLength(1)
    expect(html).not.toContain('Settings for Finance')
    // A link inside the card's link would be invalid; the card closes before the gear starts.
    const card = /<a [^>]*href="\/w\/w\/hubs\/eng"[\s\S]*?<\/a>/.exec(html)?.[0] ?? ''
    expect(card).not.toContain('settings')
    // The gear is decoration; the link's name says what it does.
    expect(html).toMatch(/<svg aria-hidden="true"/)
    // No menu any more.
    expect(html).not.toContain('aria-haspopup')
  })

  it('links a hub admin who is a member, but not an editor or a viewer', async () => {
    const adminOf = await render(WorkspaceSection, {
      entry: entry({ state: 'ready', data: [{ ...hub, hubRole: 'hub_admin' }] }),
      viewer: as('member'),
    })
    expect(adminOf).toMatch(settingsLink('eng', 'Engineering'))
    for (const viewer of [as('member'), as('viewer')]) {
      const html = await render(WorkspaceSection, {
        entry: entry({ state: 'ready', data: [hub] }),
        viewer,
      })
      expect(html, viewer.workspaceRole).not.toContain('data-hub-settings')
    }
  })

  it('shows no link while the reader’s roles are unknown', async () => {
    const html = await render(WorkspaceSection, { entry: entry({ state: 'ready', data: [hub] }) })
    expect(html).not.toContain('data-hub-settings')
  })
})

describe('WorkspaceSection new hub', () => {
  const ready = entry({ state: 'ready', data: [hub] })
  const newHubButtons = (html: string) => (html.match(/data-new-hub-button/g) ?? []).length

  it('offers owners and admins "New hub", named with the workspace', async () => {
    const html = await render(WorkspaceSection, { entry: ready, canCreateHub: true })
    expect(newHubButtons(html)).toBe(1)
    expect(html).toContain('New hub<span class="sr-only"> in Parcel Tracker</span>')
  })

  it('offers nothing to others', async () => {
    const html = await render(WorkspaceSection, { entry: ready })
    expect(html).not.toContain('New hub')
  })

  it('says how to start in an empty workspace, and only creators get the action', async () => {
    const empty = entry({ state: 'ready', data: [] })
    const creator = await render(WorkspaceSection, { entry: empty, canCreateHub: true })
    expect(creator).toContain('Create a hub to start adding items.')
    expect(creator.match(/>New hub</g)).toHaveLength(2)
    const other = await render(WorkspaceSection, { entry: empty })
    expect(other).toContain('Hubs in this workspace will show here.')
    expect(other).not.toContain('New hub')
  })

  it('keeps "New hub" while hubs load or fail to load, not for a workspace that is gone', async () => {
    const loading = await render(WorkspaceSection, {
      entry: entry({ state: 'loading' }),
      canCreateHub: true,
    })
    expect(newHubButtons(loading)).toBe(1)
    const failed = await render(WorkspaceSection, {
      entry: entry({ state: 'error', error: new ApiRequestError('network', 'Unreachable') }),
      canCreateHub: true,
    })
    expect(newHubButtons(failed)).toBe(1)
    for (const error of [
      new ApiRequestError('forbidden', 'No', 403),
      new ApiRequestError('not_found', 'Gone', 404),
    ]) {
      const html = await render(WorkspaceSection, {
        entry: entry({ state: 'error', error }),
        canCreateHub: true,
      })
      expect(newHubButtons(html)).toBe(0)
    }
  })
})

describe('NewHubDialog', () => {
  const create = () => Promise.resolve({ ok: false as const, message: 'unused' })

  it('asks for a name, an ID prefix and a colour, in the workspace named', async () => {
    const html = await render(NewHubDialog, {
      open: true,
      workspaceName: 'Parcel Tracker',
      usedColors: ['indigo', 'blue'],
      create,
    })
    expect(html).toContain('New hub')
    expect(html).toContain('In Parcel Tracker. You become its hub admin.')
    expect(html).toMatch(/<label[^>]*>Name<\/label>/)
    expect(html).toMatch(/<label[^>]*>ID prefix<\/label>/)
    expect(html).toContain('It cannot be changed later.')
    expect(html).toContain('role="radiogroup"')
    // The first colour no hub uses yet is chosen.
    expect(html).toMatch(/value="cyan"[^>]*checked|checked[^>]*value="cyan"/)
    expect(html).toContain('Create hub')
    expect(html).not.toContain('role="alert"')
  })

  it('renders nothing inside while closed', async () => {
    const html = await render(NewHubDialog, { workspaceName: 'Parcel Tracker', create })
    expect(html).not.toContain('Create hub')
  })
})
