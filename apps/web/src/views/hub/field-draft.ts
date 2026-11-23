import { ref, shallowRef, watch, type Ref } from 'vue'
import { normalizeRichText, richTextToPlain } from '../../ui/index.ts'

/**
 * A value that arrived while the reader was editing. `by` names who saved it; `null` means it
 * is the reader's own earlier save, undone because the server did not take it.
 */
export interface Incoming<T> {
  value: T
  by: string | null
}

export interface FieldDraft<T> {
  draft: Ref<T>
  incoming: Readonly<Ref<Incoming<T> | null>>
  /**
   * Takes the draft for saving: the version it was based on, or `null` when there is nothing
   * to save (unchanged after all, in which case a value that came meanwhile is simply shown).
   */
  take: () => { basedOn: number | null } | null
  /** Starts the next edit from the value shown now, as if the reader had just opened it. */
  rebase: () => void
  /** Drops the draft for `value`, which the reader is saving some other way ("Keep mine"). */
  reset: (value: T) => void
}

/**
 * The draft rule for one field (D60, decided by the maintainer during M3). While the reader has
 * not changed the draft, it follows the value, which is how a rolled-back edit becomes visible.
 * Once they have, a change that arrives does not replace their draft: it is shown beside the
 * field, and their save goes out against the version the draft was based on, so a change by
 * someone else meets the usual conflict.
 *
 * `key` says when two values are the same; `version` is `null` where there is no item yet.
 */
export function useFieldDraft<T>(options: {
  shown: () => T
  key: (value: T) => string
  version: () => number | null
  changedBy: () => string
  /**
   * The reader's own save of this field is still pending. A newer version that arrives meanwhile
   * may hold someone else's value hidden under it, so it does not move the base.
   */
  saving?: () => boolean
  /** The draft took the value shown, so whatever was said about the old draft is over. */
  onFollow?: () => void
}): FieldDraft<T> {
  const { shown, key, version, changedBy, saving = () => false, onFollow } = options
  const draft = ref(shown()) as Ref<T>
  /** The value the draft last followed, and the item version then: what an edit is based on. */
  let synced = { key: key(draft.value), version: version() }
  const incoming = shallowRef<Incoming<T> | null>(null)
  const editing = () => key(draft.value) !== synced.key

  function follow(value: T) {
    draft.value = value
    synced = { key: key(value), version: version() }
    incoming.value = null
    onFollow?.()
  }

  watch([() => key(shown()), version, saving], ([now, at], [before]) => {
    if (now !== before) {
      if (at !== null && editing() && now !== key(draft.value)) {
        // Someone else's save always brings a version newer than the draft's base. The value
        // changing at that same version is the reader's own pending edit going away: the server
        // refused it.
        incoming.value = { value: shown(), by: at === synced.version ? null : changedBy() }
        return
      }
      follow(shown())
    } else if (now === synced.key && !saving()) {
      // A newer version that leaves this field as it was (another field changed, or the reader's
      // own save came back) moves the base along: only a change to this field is a conflict.
      // Not while this field's save is pending: the value shown is the reader's, not the server's.
      synced = { ...synced, version: at }
    }
  })

  function take() {
    if (!editing()) {
      if (incoming.value) follow(shown())
      return null
    }
    const basedOn = synced.version
    incoming.value = null
    // From here the draft follows the value again, so a rolled-back edit shows.
    synced = { key: key(draft.value), version: basedOn }
    return { basedOn }
  }

  function rebase() {
    synced = { key: key(shown()), version: version() }
  }

  return { draft, incoming, take, rebase, reset: follow }
}

/** A value as the notes quote it: in quotes, or "no value". */
export const quoted = (text: string) => (text === '' ? 'no value' : `“${text}”`)

/** At most `max` characters of `text` on one line, for quoting a long value in a note. */
export function excerpt(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** A rich text value as one shortened line, for quoting it in a note. */
export const richTextExcerpt = (value: unknown) =>
  excerpt(richTextToPlain(normalizeRichText(value)))

/** The note shown beside a field whose draft was kept. */
export function incomingNote(incoming: Incoming<unknown>, text: string): string {
  return incoming.by === null
    ? `Your last change was not saved, so the saved value is still ${quoted(text)}. Save again to keep yours.`
    : `Changed by ${incoming.by} while you were editing: ${quoted(text)}. Saving yours will ask which to keep.`
}
