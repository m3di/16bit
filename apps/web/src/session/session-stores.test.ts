import { describe, expect, it } from 'vitest'
import { fakeApi, json } from '../views/hub/fixtures.test-utils.ts'
import { person } from './fixtures.test-utils.ts'
import { workspaceStore } from '../sync/store.ts'
import { createSession } from './session.ts'

// When the session ends or another one starts, the tab's workspace stores and feeds go, so
// nothing read under one session is served under the next (issue 175).

describe('session and the workspace stores', () => {
  it('drops the stores on expiry (a 401 or a feed closed with 4401)', () => {
    const before = workspaceStore('w')
    createSession(fakeApi(() => json({})).fetchFn).expire()
    expect(workspaceStore('w')).not.toBe(before)
  })

  it('drops the stores on sign-out', async () => {
    const before = workspaceStore('w')
    const api = fakeApi(() => new Response(null, { status: 204 }))
    await createSession(api.fetchFn).signOut()
    expect(workspaceStore('w')).not.toBe(before)
  })

  it('drops the stores on sign-in', async () => {
    const before = workspaceStore('w')
    const session = createSession(fakeApi(() => json(person)).fetchFn)
    await session.signIn({ email: 'a@example.com', password: 'x' })
    expect(workspaceStore('w')).not.toBe(before)
  })
})
