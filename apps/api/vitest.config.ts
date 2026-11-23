import { configDefaults, defineProject } from 'vitest/config'

/**
 * Wall-clock timing budgets (D61, D80). They hold on an idle runner but not next to the rest of
 * the suite (#293), so `pnpm test` never runs them. CI runs them alone after it, one file at a
 * time, with `pnpm test:budgets` (vitest.budgets.config.ts). Never run them locally: the
 * 50,000-item seed is the heavy run CLAUDE.md keeps off the maintainer's laptop.
 */
export const BUDGET_TESTS = ['src/query-window.test.ts', 'src/aggregate-budget.test.ts']

export default defineProject({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...BUDGET_TESTS],
    environment: 'node',
  },
})
