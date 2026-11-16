import { describe, expect, it } from 'vitest'
import { avatarSprite, hashId, spritePath, SPRITE_SIZE } from './avatar.ts'
import { PALETTE } from './palette.ts'

const ids = Array.from({ length: 2000 }, (_, i) => `principal-${String(i)}`)

describe('avatarSprite', () => {
  it('is deterministic for the same ID', () => {
    for (const id of ['sara', 'qa-agent', '0198c1d2-7e44-7c1a-9b3e-5f1a2b3c4d5e', '']) {
      expect(avatarSprite(id)).toEqual(avatarSprite(id))
      expect(spritePath(avatarSprite(id).cells)).toBe(spritePath(avatarSprite(id).cells))
    }
  })

  it('does not change between releases for a known ID', () => {
    // Pinned so a change to the algorithm is a deliberate decision: every avatar would change.
    const { color, cells } = avatarSprite('sara')
    const rows = Array.from({ length: SPRITE_SIZE }, (_, y) =>
      cells
        .slice(y * SPRITE_SIZE, (y + 1) * SPRITE_SIZE)
        .map((on) => (on ? '#' : '.'))
        .join(''),
    )
    expect(hashId('sara')).toBe(973396533)
    expect(color).toBe('lime')
    expect(rows).toEqual(['##.##', '..#..', '.###.', '.###.', '..#..'])
  })

  it('is mirrored left to right', () => {
    for (const id of ids.slice(0, 200)) {
      const { cells } = avatarSprite(id)
      for (let y = 0; y < SPRITE_SIZE; y++) {
        for (let x = 0; x < SPRITE_SIZE; x++) {
          expect(cells[y * SPRITE_SIZE + x]).toBe(cells[y * SPRITE_SIZE + (SPRITE_SIZE - 1 - x)])
        }
      }
    }
  })

  it('always draws a shape, never an empty or solid square', () => {
    for (const id of ids) {
      const filled = avatarSprite(id).cells.filter(Boolean).length
      expect(filled).toBeGreaterThan(0)
      expect(filled).toBeLessThan(SPRITE_SIZE * SPRITE_SIZE)
    }
  })

  it('tells IDs apart and uses the whole palette', () => {
    const keys = new Set(ids.map((id) => JSON.stringify(avatarSprite(id))))
    expect(keys.size).toBeGreaterThan(ids.length * 0.95)
    const colors = new Set(ids.map((id) => avatarSprite(id).color))
    expect(colors.size).toBe(PALETTE.length)
  })

  it('changes with a one-character difference', () => {
    expect(avatarSprite('user-1')).not.toEqual(avatarSprite('user-2'))
  })
})

describe('spritePath', () => {
  it('draws one unit square per filled cell', () => {
    const cells = Array.from({ length: 25 }, (_, i) => i === 0 || i === 24)
    expect(spritePath(cells)).toBe('M0 0h1v1h-1zM4 4h1v1h-1z')
  })
})
