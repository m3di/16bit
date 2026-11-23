import { defineConfig } from 'vitest/config'
import { BUDGET_TESTS } from './vitest.config.ts'

// Only the timing budgets, one file at a time with nothing else running (#293). CI only.
export default defineConfig({
  test: {
    name: 'api-budgets',
    include: BUDGET_TESTS,
    environment: 'node',
    fileParallelism: false,
    // Temporary: the 50,000-item aggregate sits near its 2 s limit on hosted runners (1.5-2.2 s,
    // PR #296). Remove this when #299, which makes that query faster, merges. The limit stays.
    retry: 1,
  },
})
