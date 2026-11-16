import { PALETTE, type PaletteColor } from './palette.ts'

export const SPRITE_SIZE = 5

export interface AvatarSprite {
  color: PaletteColor
  /** 25 cells, row by row. `true` is drawn in the colour's ink shade over its tint. */
  cells: boolean[]
}

/** FNV-1a over UTF-16 code units, then the murmur3 finaliser so every output bit depends on every input bit. */
export function hashId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function countBits(n: number): number {
  let count = 0
  for (let v = n; v !== 0; v >>>= 1) count += v & 1
  return count
}

/**
 * A 5 by 5 sprite, mirrored left to right, derived only from the principal ID.
 * The low 4 bits pick the palette colour; the next 15 bits fill the left three columns.
 * Nearly empty or nearly full patterns are flipped against a checker so every avatar has a shape.
 */
export function avatarSprite(id: string): AvatarSprite {
  const h = hashId(id)
  const color = PALETTE[h & 0xf] as PaletteColor
  let bits = (h >>> 4) & 0x7fff
  const filled = countBits(bits)
  if (filled < 3 || filled > 12) bits ^= 0x5555

  const cells: boolean[] = []
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const col = x < 3 ? x : SPRITE_SIZE - 1 - x
      cells.push(((bits >>> (y * 3 + col)) & 1) === 1)
    }
  }
  return { color, cells }
}

/** SVG path data for the filled cells, in a 5 by 5 viewBox. */
export function spritePath(cells: readonly boolean[]): string {
  let d = ''
  cells.forEach((on, i) => {
    if (on) d += `M${String(i % SPRITE_SIZE)} ${String(Math.floor(i / SPRITE_SIZE))}h1v1h-1z`
  })
  return d
}
