import type { ItemValues, RevisionEntry } from '@16bit/core'

type Value = ItemValues[string]

/** One attribute an entry changed. `before` is only set when the older value is known. */
export interface HistoryChange {
  attributeId: string
  after: Value
  before: { value: Value | undefined } | null
}

/**
 * What one revision changed, newest-first `entries` being everything loaded so far. An update's
 * patch holds only the new values, so the old value comes from the nearest older loaded entry
 * that wrote the same attribute. When the item's create is loaded and nothing before wrote it,
 * the attribute was empty. Otherwise the old value is not known and is left out, never guessed.
 */
export function changesOf(entries: readonly RevisionEntry[], index: number): HistoryChange[] {
  const entry = entries[index]
  if (!entry || entry.patch.op === 'delete') return []
  const createLoaded = entries.some((e) => e.patch.op === 'create')
  return (
    Object.entries(entry.patch.values)
      .filter(([, after]) => entry.patch.op !== 'create' || !isEmpty(after))
      .map(([attributeId, after]): HistoryChange => {
        if (entry.patch.op === 'create') return { attributeId, after, before: null }
        for (const older of entries.slice(index + 1)) {
          if (older.patch.op === 'delete') continue
          if (Object.hasOwn(older.patch.values, attributeId)) {
            return { attributeId, after, before: { value: older.patch.values[attributeId] } }
          }
        }
        return { attributeId, after, before: createLoaded ? { value: undefined } : null }
      })
      // Clearing a value that was already empty changed nothing the reader could see.
      .filter((c) => !(c.before && isEmpty(c.before.value) && isEmpty(c.after)))
  )
}

export const isEmpty = (v: Value | undefined) =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0)

export interface EvidenceLink {
  href: string
  host: string
  /** Path, query and fragment after the host, without a lone trailing slash. */
  rest: string
}

/**
 * An evidence URL as a link: only `http` and `https`, and the host is always shown so the reader
 * sees where a link goes before following it. Anything else is null and is shown as text.
 */
export function evidenceLink(value: string): EvidenceLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const rest = `${url.pathname}${url.search}${url.hash}`
  return { href: url.href, host: url.host, rest: rest === '/' ? '' : rest }
}

/** The DOM ID of an entry, so "follows change N" can point at it. */
export const changeAnchor = (seq: number) => `change-${String(seq)}`
