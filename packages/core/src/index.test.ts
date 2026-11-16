import { describe, expect, it } from 'vitest'

describe('@16bit/core', () => {
  it('loads', async () => {
    await expect(import('./index.ts')).resolves.toBeDefined()
  })
})
