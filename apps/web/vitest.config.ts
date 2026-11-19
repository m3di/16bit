import { fileURLToPath } from 'node:url'
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
      // `@vitest-environment client-node`: Node, with components compiled for the browser. The
      // docblock only takes a name (Vitest 5.1 matches /[\w-]+/), not a path, hence the alias.
      alias: {
        'vitest-environment-client-node': fileURLToPath(
          new URL('./src/test/client-environment.ts', import.meta.url),
        ),
      },
    },
  }),
)
