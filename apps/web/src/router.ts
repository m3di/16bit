import { createRouter, createWebHistory, type RouteRecordRaw, type RouterHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

const routes: RouteRecordRaw[] = [{ path: '/', name: 'home', component: HomeView }]

// The component kit is a local tool. It is left out of production builds.
if (import.meta.env.DEV) {
  routes.push({ path: '/kit', name: 'kit', component: () => import('./views/KitView.vue') })
}

export function makeRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes })
}
