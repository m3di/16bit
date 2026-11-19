import { createRouter, createWebHistory, type RouteRecordRaw, type RouterHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** Open without a session. A 401 here does not redirect to sign-in. */
    public?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  {
    // `?next=` is where to go after signing in (same-origin paths only, see session/next.ts).
    path: '/sign-in',
    name: 'sign-in',
    component: () => import('./views/SignInView.vue'),
    meta: { public: true },
  },
  {
    path: '/invite/:token',
    name: 'invite',
    component: () => import('./views/InviteView.vue'),
    meta: { public: true },
  },
  {
    // The selected folder is optional: without it the hub's own items show. `?item=` opens
    // the item panel, so a selected item can be linked and survives a reload.
    path: '/w/:workspaceId/hubs/:hubId/:folderId?',
    name: 'hub',
    component: () => import('./views/HubView.vue'),
  },
  {
    path: '/w/:workspaceId/settings',
    redirect: (to) => ({ name: 'workspace-members', params: to.params }),
  },
  {
    // Workspace settings: members and invites. Every person in the workspace may open it;
    // what they can change follows their role.
    path: '/w/:workspaceId/settings/members',
    name: 'workspace-members',
    component: () => import('./views/WorkspaceSettingsView.vue'),
    props: (to) => ({ workspaceId: String(to.params['workspaceId'] ?? '') }),
  },
]

// The component kit is a local tool. It is left out of production builds.
if (import.meta.env.DEV) {
  routes.push({ path: '/kit', name: 'kit', component: () => import('./views/KitView.vue') })
}

export function makeRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes })
}
