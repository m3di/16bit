import type { Environment } from 'vitest/runtime'

// Node globals, but modules are transformed for the browser: single-file components get their
// client render functions instead of the SSR ones. For tests that mount a component with a
// custom renderer instead of a DOM (base-input.test.ts).
export default {
  name: 'client-node',
  viteEnvironment: 'client',
  setup: () => ({ teardown: () => undefined }),
} satisfies Environment
