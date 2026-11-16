import { createSSRApp, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import type { Load, WorkspaceEntry } from './useDashboard.ts'
import WorkspaceList from './WorkspaceList.vue'

// The page-level states of HomeView, which renders WorkspaceList for them.
const render = async (workspaces: Load<WorkspaceEntry[]>) => {
  const router = createRouter({
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
  const app = createSSRApp({ render: () => h(WorkspaceList, { workspaces }) }).use(router)
  await router.push('/')
  await router.isReady()
  return renderToString(app)
}

describe('WorkspaceList', () => {
  it('renders the loading state', async () => {
    expect(await render({ state: 'loading' })).toContain('Loading workspaces')
  })

  it('renders the empty state', async () => {
    const html = await render({ state: 'ready', data: [] })
    expect(html).toContain('No workspaces yet')
    expect(html).toContain('data-state="empty"')
  })

  it('renders the error state with a retry', async () => {
    const html = await render({
      state: 'error',
      error: new ApiRequestError('network', 'The server could not be reached.'),
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Your workspaces could not be loaded')
    expect(html).toContain('The server could not be reached.')
    expect(html).toContain('Try again')
  })

  it('renders the no-permission state without a retry', async () => {
    const html = await render({
      state: 'error',
      error: new ApiRequestError('unauthorized', 'No', 401),
    })
    expect(html).toContain('data-state="no-permission"')
    expect(html).toContain('The API did not accept this session')
    expect(html).not.toContain('Try again')
  })

  it('renders one section per workspace', async () => {
    const html = await render({
      state: 'ready',
      data: [
        {
          workspace: { id: 'w', name: 'Acme', createdAt: '2026-11-16T00:00:00.000Z' },
          hubs: { state: 'ready', data: [] },
        },
      ],
    })
    expect(html.match(/data-workspace/g)).toHaveLength(1)
  })
})
