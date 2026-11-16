// Lets plain TypeScript tooling (typescript-eslint's project service) type `.vue` imports.
// vue-tsc resolves the real component types and ignores this fallback.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
