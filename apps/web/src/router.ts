import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'
import HomeView from './views/HomeView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** Open without a session. A 401 here does not redirect to sign-in. */
    public?: boolean
  }
}

const hubParams = (to: RouteLocationNormalized) => ({
  workspaceId: String(to.params['workspaceId'] ?? ''),
  hubId: String(to.params['hubId'] ?? ''),
})

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
    // Hub settings : folders and attributes so far; the general, access and key sections come next. Every reader
    // with a grant may open it; only hub admins change anything (`hub.manageSchema`).
    path: '/w/:workspaceId/hubs/:hubId/settings',
    redirect: (to) => ({ name: 'hub-settings-folders', params: to.params }),
  },
  {
    path: '/w/:workspaceId/hubs/:hubId/settings/folders',
    name: 'hub-settings-folders',
    component: () => import('./views/HubSettingsView.vue'),
    props: (to) => ({ ...hubParams(to), section: 'folders' }),
  },
  {
    path: '/w/:workspaceId/hubs/:hubId/settings/attributes',
    name: 'hub-settings-attributes',
    component: () => import('./views/HubSettingsView.vue'),
    props: (to) => ({ ...hubParams(to), section: 'attributes' }),
  },
  {
    // The selected folder is optional: without it the hub's own items show. `?item=` opens
    // the item panel, so a selected item can be linked and survives a reload.
    path: '/w/:workspaceId/hubs/:hubId/:folderId?',
    name: 'hub',
    component: () => import('./views/HubView.vue'),
  },
]

// The component kit is a local tool. It is left out of production builds.
if (import.meta.env.DEV) {
  routes.push({ path: '/kit', name: 'kit', component: () => import('./views/KitView.vue') })
}

export function makeRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes })
}
