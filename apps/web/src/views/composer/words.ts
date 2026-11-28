import type { FilterOperator, SummaryFunction } from '@16bit/core'

// The composer's words for core's operators and summaries.

export const OP_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is any of',
  not_in: 'is none of',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_stale: 'is stale',
}

export const FN_LABELS: Record<SummaryFunction, string> = {
  count: 'Count',
  count_empty: 'Count empty',
  count_not_empty: 'Count not empty',
  count_unique: 'Count unique',
  sum: 'Sum',
  avg: 'Average',
  min: 'Smallest',
  max: 'Largest',
  earliest: 'Earliest',
  latest: 'Latest',
  count_true: 'Count yes',
  count_false: 'Count no',
}

export const NO_VALUE_OPS: readonly FilterOperator[] = ['is_empty', 'is_not_empty', 'is_stale']
export const LIST_OPS: readonly FilterOperator[] = ['in', 'not_in']
