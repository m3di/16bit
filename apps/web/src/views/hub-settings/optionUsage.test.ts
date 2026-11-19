import type { Attribute, AttributeUsage } from '@16bit/core'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.ts'
import { description } from './fixtures.test-utils.ts'
import { usageNote, useOptionUsage } from './optionUsage.ts'

const attr = (id: string): Attribute => {
  const a = description().attributes.find((x) => x.id === id)
  if (!a) throw new Error(`no attribute ${id}`)
  return a
}
const answerFor = (a: Attribute, version = a.version): AttributeUsage => ({
  attributeId: a.id,
  version,
  options:
    a.type === 'select' || a.type === 'multi_select'
      ? a.config.options.map((o, i) => ({ optionId: o.id, items: i * 3 }))
      : [],
})

describe('useOptionUsage (#147)', () => {
  it('counts items per option for a select', async () => {
    const stage = attr('stage')
    const reads: string[] = []
    const u = useOptionUsage((a) => {
      reads.push(a.id)
      return Promise.resolve(answerFor(a))
    })
    const done = u.load(stage)
    expect(u.usage.value).toEqual({ state: 'loading' })
    await done
    expect(reads).toEqual(['stage'])
    const v = u.usage.value
    expect(v.state === 'ready' && Object.values(v.counts)[1]).toBe(3)
  })

  it('reads nothing for other types or a new attribute', async () => {
    let reads = 0
    const u = useOptionUsage((a) => {
      reads++
      return Promise.resolve(answerFor(a))
    })
    await u.load(attr('title'))
    await u.load(null)
    expect(reads).toBe(0)
    expect(u.usage.value).toEqual({ state: 'none' })
  })

  it('hides counts that belong to another version of the attribute', async () => {
    const stage = attr('stage')
    const u = useOptionUsage((a) => Promise.resolve(answerFor(a, a.version + 1)))
    await u.load(stage)
    expect(u.usage.value).toEqual({ state: 'stale' })
  })

  it('keeps only the latest read', async () => {
    const stage = attr('stage')
    let resolveFirst: (v: AttributeUsage) => void = () => undefined
    const first = new Promise<AttributeUsage>((r) => (resolveFirst = r))
    let calls = 0
    const u = useOptionUsage(() => (++calls === 1 ? first : Promise.reject(new Error('x'))))
    const a = u.load(stage)
    u.clear()
    resolveFirst(answerFor(stage))
    await a
    expect(u.usage.value).toEqual({ state: 'none' })
  })

  it('says why counts are missing, with a retry only where one can help', async () => {
    const stage = attr('stage')
    const failWith = async (error: ApiRequestError) => {
      const u = useOptionUsage(() => Promise.reject(error))
      await u.load(stage)
      return u.usage.value
    }
    expect(await failWith(new ApiRequestError('forbidden', 'No', 403))).toMatchObject({
      state: 'error',
      retry: false,
      message: 'Only hub admins see how many items use each option.',
    })
    expect(await failWith(new ApiRequestError('not_found', 'Gone', 404))).toMatchObject({
      state: 'error',
      retry: false,
      message: 'This attribute is no longer available.',
    })
    expect(await failWith(new ApiRequestError('network', 'Unreachable'))).toMatchObject({
      state: 'error',
      retry: true,
    })
  })
})

describe('usageNote', () => {
  it('warns that multi-select counts do not add up, and says nothing for a ready select', () => {
    const ready = { state: 'ready', counts: {} } as const
    expect(usageNote(ready, 'multi_select')).toContain('can add up to more than')
    expect(usageNote(ready, 'select')).toBe('')
    expect(usageNote({ state: 'loading' }, 'select')).toBe(
      'Counting the items that use each option.',
    )
    expect(usageNote({ state: 'stale' }, 'select')).toContain('counts are not shown')
  })
})
