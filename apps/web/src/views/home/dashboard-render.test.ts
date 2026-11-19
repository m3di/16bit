import type { HubListEntry } from '@16bit/core'
import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import AppShell from '../../ui/AppShell.vue'
import HubCard from '../../ui/HubCard.vue'
import type { WorkspaceEntry } from './useDashboard.ts'
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
    // No grant offer in M1: self-granting is API-only (docs/ROLES.md).
    expect(html).not.toContain('<button')
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
