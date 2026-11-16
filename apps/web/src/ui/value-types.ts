/** D18 for a single value: loading, empty, error, no permission. */
export type ValueStateName = 'loading' | 'empty' | 'error' | 'no-permission'

export interface Actor {
  /** Principal ID. Draws the avatar. */
  id: string
  name: string
  kind: 'person' | 'agent'
}

/** A linked item as the query endpoint expands it, or the marker for one the reader cannot see. */
export type RelationTarget =
  | { access: 'ok'; id: string; title: string; displayId?: string | undefined }
  | { access: 'none'; id: string }

export type SignInState = 'idle' | 'submitting' | 'error' | 'no-permission'
