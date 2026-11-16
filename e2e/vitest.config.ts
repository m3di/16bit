import { defineProject } from 'vitest/config'

// Vitest only runs *.test.ts here. Playwright owns tests/*.spec.ts.
export default defineProject({
  test: {
    name: 'e2e',
    include: ['*.test.ts'],
  },
})
