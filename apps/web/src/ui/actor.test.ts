import { describe, expect, it } from 'vitest'
import { shortId } from './actor.ts'

describe('shortId', () => {
  it('keeps the first 8 characters', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567')
  })

  it('leaves short IDs whole', () => {
    expect(shortId('qa')).toBe('qa')
  })
})
