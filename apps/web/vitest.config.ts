import { defineProject, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: 'web',
      include: ['src/**/*.test.ts'],
      environment: 'node',
      // tokens.test.ts reads tokens.css as text to check contrast.
      css: { include: [/tokens\.css/] },
    },
  }),
)
