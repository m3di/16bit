import type { Me } from '@16bit/core'
import { describe, expect, it, vi } from 'vitest'
import { json } from '../../session/fixtures.test-utils.ts'
import { fakeApi, invite, meAs, member, people, WS, type Handler } from './fixtures.test-utils.ts'
import { useWorkspaceMembers } from './useWorkspaceMembers.ts'

const base = `/v1/workspaces/${WS}`
const page = (items: unknown[]) => json({ items, nextCursor: null })
const noBody = () => new Response(null, { status: 204 })
const refused = () => json({ error: 'forbidden', message: 'Your role does not allow this' }, 403)

function setup(me: Me | null, routes: Record<string, Handler> = {}) {
  const api = fakeApi({
    [`GET ${base}/members`]: () => page(people.map((p) => ({ ...p }))),
    [`GET ${base}/invites`]: () => page([invite('i1', 'member'), invite('i2', 'viewer')]),
    ...routes,
  })
  const onSelfChange = vi.fn()
  const model = useWorkspaceMembers(WS, () => me, api.fetchFn, onSelfChange)
  return { ...api, model, onSelfChange }
}

const roleOf = (model: ReturnType<typeof setup>['model'], id: string) =>
  model.members.value.state === 'ready'
    ? model.members.value.data.find((p) => p.id === id)?.workspaceRole
    : undefined

describe('loading', () => {
  it('loads members, then invites for an owner', async () => {
    const { model, calls } = setup(meAs('p-sara', 'owner'))
    await model.load()
    expect(model.members.value.state).toBe('ready')
    expect(model.invites.value).toMatchObject({
      state: 'ready',
      data: [{ id: 'i1' }, { id: 'i2' }],
    })
    expect(calls.map((c) => c.path)).toEqual([`${base}/members`, `${base}/invites`])
  })

  it('never asks for invites as a member, viewer or finance', async () => {
    for (const role of ['member', 'viewer', 'finance'] as const) {
      const { model, calls } = setup(meAs('p-tomas', role))
      await model.load()
      expect(model.invites.value).toEqual({ state: 'hidden' })
      expect(calls.some((c) => c.path.endsWith('/invites'))).toBe(false)
    }
  })

  it('takes the reader’s role from the member list over the session', async () => {
    // The session still says admin; the list says member now.
    const { model } = setup(meAs('p-tomas', 'admin'))
    await model.load()
    expect(model.viewer.value?.workspaceRole).toBe('member')
    expect(model.invites.value).toEqual({ state: 'hidden' })
  })

  it('keeps a 404 and a 403 apart from other errors', async () => {
    const notFound = setup(meAs('p-sara', 'owner'), {
      [`GET ${base}/members`]: () =>
        json({ error: 'not_found', message: 'Workspace not found' }, 404),
    })
    await notFound.model.load()
    expect(
      notFound.model.members.value.state === 'error' &&
        notFound.model.members.value.error.isNotFound,
    ).toBe(true)

    const broken = setup(meAs('p-sara', 'owner'), {
      [`GET ${base}/invites`]: () => json({ error: 'internal', message: 'Boom' }, 500),
    })
    await broken.model.load()
    expect(broken.model.members.value.state).toBe('ready')
    expect(broken.model.invites.value.state).toBe('error')
  })

  it('has no viewer for an agent', () => {
    const agent: Me = {
      kind: 'agent',
      principalId: 'a1',
      workspace: { id: WS, name: 'Parcel Tracker' },
      hub: { id: 'h', name: 'Hub' },
      hubRole: 'editor',
    }
    const { model } = setup(agent)
    expect(model.viewer.value).toBeNull()
  })
})

describe('changing a role', () => {
  it('shows the new role at once and keeps it when the API agrees', async () => {
    let release: () => void = () => undefined
    const { model, calls } = setup(meAs('p-sara', 'owner'), {
      [`PATCH ${base}/members/p-tomas`]: (body) =>
        new Promise((resolve) => {
          release = () => {
            resolve(json({ ...member('p-tomas', 'Tomas', 'member'), ...(body as object) }))
          }
        }),
    })
    await model.load()
    const done = model.changeRole('p-tomas', 'viewer')
    expect(roleOf(model, 'p-tomas')).toBe('viewer')
    release()
    await done
    expect(roleOf(model, 'p-tomas')).toBe('viewer')
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { workspaceRole: 'viewer' } })
    expect(model.notice.value).toBeNull()
  })

  it('rolls back with a notice when the API refuses, and reads the list again', async () => {
    const { model, calls } = setup(meAs('p-priya', 'admin'), {
      [`PATCH ${base}/members/p-tomas`]: refused,
    })
    await model.load()
    await model.changeRole('p-tomas', 'finance')
    expect(roleOf(model, 'p-tomas')).toBe('member')
    expect(model.notice.value).toBe(
      "Tomas's role was not changed to Finance. Your role does not allow this.",
    )
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.path.endsWith('/members') && c.method === 'GET')).toHaveLength(2)
    })
  })

  it('rolls back to the last saved role when an earlier change succeeded', async () => {
    let n = 0
    const { model } = setup(meAs('p-sara', 'owner'), {
      [`PATCH ${base}/members/p-tomas`]: (body) =>
        ++n === 1
          ? json({ ...member('p-tomas', 'Tomas', 'member'), ...(body as object) })
          : json({ error: 'internal', message: 'Boom' }, 500),
    })
    await model.load()
    await model.changeRole('p-tomas', 'viewer')
    await model.changeRole('p-tomas', 'admin')
    expect(roleOf(model, 'p-tomas')).toBe('viewer')
    expect(model.notice.value).toBe("Tomas's role was not changed to Admin. Boom")
  })

  it('drops a person someone else removed meanwhile', async () => {
    const { model } = setup(meAs('p-sara', 'owner'), {
      [`PATCH ${base}/members/p-tomas`]: () =>
        json({ error: 'not_found', message: 'Member not found' }, 404),
    })
    await model.load()
    await model.changeRole('p-tomas', 'viewer')
    expect(roleOf(model, 'p-tomas')).toBeUndefined()
    expect(model.notice.value).toBe('Tomas is no longer a member of this workspace.')
  })

  it('reads the session again after changing the reader’s own role', async () => {
    const { model, onSelfChange } = setup(meAs('p-sara', 'owner'), {
      [`PATCH ${base}/members/p-sara`]: (body) =>
        json({ ...member('p-sara', 'Sara', 'owner'), ...(body as object) }),
    })
    await model.load()
    await model.changeRole('p-sara', 'admin')
    expect(onSelfChange).toHaveBeenCalledOnce()
  })
})

describe('removing a member', () => {
  it('drops the row once the API agrees', async () => {
    const { model, calls } = setup(meAs('p-sara', 'owner'), {
      [`DELETE ${base}/members/p-tomas`]: noBody,
    })
    await model.load()
    expect(await model.remove('p-tomas')).toEqual({ self: false })
    expect(roleOf(model, 'p-tomas')).toBeUndefined()
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', body: undefined })
  })

  it('keeps the row and throws when refused, for the dialog to show', async () => {
    const { model } = setup(meAs('p-priya', 'admin'), {
      [`DELETE ${base}/members/p-sara`]: refused,
    })
    await model.load()
    await expect(model.remove('p-sara')).rejects.toMatchObject({ status: 403 })
    expect(roleOf(model, 'p-sara')).toBe('owner')
  })

  it('counts a 404 as done, and tells the session when the reader left', async () => {
    const { model, onSelfChange } = setup(meAs('p-priya', 'admin'))
    await model.load()
    expect(await model.remove('p-priya')).toEqual({ self: true })
    expect(roleOf(model, 'p-priya')).toBeUndefined()
    expect(onSelfChange).toHaveBeenCalledOnce()
  })
})

describe('invites', () => {
  it('revokes at once and keeps it gone when the API agrees', async () => {
    const { model, calls } = setup(meAs('p-sara', 'owner'), {
      [`POST ${base}/invites/i1/revoke`]: noBody,
    })
    await model.load()
    const done = model.revokeInvite('i1')
    expect(model.invites.value).toMatchObject({ data: [{ id: 'i2' }] })
    await done
    expect(model.invites.value).toMatchObject({ data: [{ id: 'i2' }] })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `${base}/invites/i1/revoke` })
  })

  it('puts a refused revoke back in its place with a notice', async () => {
    const { model } = setup(meAs('p-sara', 'owner'), {
      [`POST ${base}/invites/i1/revoke`]: () => json({ error: 'internal', message: 'Boom' }, 500),
    })
    await model.load()
    await model.revokeInvite('i1')
    expect(model.invites.value).toMatchObject({ data: [{ id: 'i1' }, { id: 'i2' }] })
    expect(model.notice.value).toBe('The member invite was not revoked. Boom')
  })

  it('adds a created invite to the top of the list and returns its token', async () => {
    const created = invite('i3', 'admin')
    const { model, calls } = setup(meAs('p-sara', 'owner'), {
      [`POST ${base}/invites`]: () =>
        json({ invite: created, token: 'tok_abcdefghijklmnopqrstuvwxyz' }, 201),
    })
    await model.load()
    const result = await model.createInvite('admin', 3)
    expect(result.token).toBe('tok_abcdefghijklmnopqrstuvwxyz')
    expect(calls.at(-1)?.body).toEqual({ workspaceRole: 'admin', expiresInDays: 3 })
    expect(model.invites.value).toMatchObject({ data: [{ id: 'i3' }, { id: 'i1' }, { id: 'i2' }] })
  })

  it('throws a refused create for the dialog', async () => {
    const { model } = setup(meAs('p-priya', 'admin'), { [`POST ${base}/invites`]: refused })
    await model.load()
    await expect(model.createInvite('owner', 7)).rejects.toMatchObject({ status: 403 })
  })
})
