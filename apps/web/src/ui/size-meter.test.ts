import { describe, expect, it } from 'vitest'
import { sizeLevel } from './size-meter.ts'

describe('sizeLevel', () => {
  it.each([
    [0, 1],
    [1, 1],
    [9, 1],
    [10, 2],
    [99, 2],
    [100, 3],
    [999, 3],
    [1000, 4],
    [1280, 4],
    [5_000_000, 4],
  ])('%i items fill %i squares', (count, level) => {
    expect(sizeLevel(count)).toBe(level)
  })

  it('treats invalid counts as under 10', () => {
    expect(sizeLevel(-5)).toBe(1)
    expect(sizeLevel(Number.NaN)).toBe(1)
  })
})
