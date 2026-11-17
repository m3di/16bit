import type { Folder } from '@16bit/core'
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
    ],
  })

const render = async (c: Component, props: Record<string, unknown> = {}) => {
  const r = router()
  const app = createSSRApp({ render: () => h(c, props) }).use(r)
  await r.push('/')
  await r.isReady()
  return renderToString(app)
}

const hub: Folder = {
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
