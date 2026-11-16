import { describe, expect, it } from 'vitest'
import { sizeLevel } from './size-meter.ts'

describe('sizeLevel', () => {
  it.each([
    [0, 0],
    [0.5, 0],
    [1, 1],
    [9, 1],
    [10, 2],
    [99, 2],
    [100, 3],
    [999, 3],
    [1000, 4],
    [1280, 4],
    [5_000_000, 4],
  ])('%d items fill %i squares', (count, level) => {
    expect(sizeLevel(count)).toBe(level)
  })

  it('treats invalid counts as empty', () => {
    expect(sizeLevel(-5)).toBe(0)
    expect(sizeLevel(Number.NaN)).toBe(0)
    expect(sizeLevel(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
