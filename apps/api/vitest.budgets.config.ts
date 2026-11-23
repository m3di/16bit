import { defineConfig } from 'vitest/config'
import { BUDGET_TESTS } from './vitest.config.ts'

// Only the timing budgets, one file at a time with nothing else running (#293). CI only.
export default defineConfig({
  test: {
    name: 'api-budgets',
    include: BUDGET_TESTS,
    environment: 'node',
    fileParallelism: false,
  },
})
