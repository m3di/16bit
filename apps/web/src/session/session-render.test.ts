import type { Me } from '@16bit/core'
import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../api/client.ts'
import type { Load } from '../views/home/useDashboard.ts'
import InviteView from '../views/InviteView.vue'
import SignInView from '../views/SignInView.vue'
import { makeRouter } from '../router.ts'
import { person } from './fixtures.test-utils.ts'
import { createSession, sessionKey } from './session.ts'
import ShellUser from './ShellUser.vue'

const TOKEN = 'T'.repeat(43)

/** Renders `component` at `path` with a session whose user is `me`. */
async function render(component: Component, path: string, me: Load<Me | null>) {
  const router = makeRouter(createMemoryHistory())
  const session = createSession(() => Promise.reject(new Error('no network in render tests')))
  session.me.value = me
  const app = createSSRApp({ render: () => h(component) })
    .provide(sessionKey, session)
    .use(router)
  await router.push(path)
  await router.isReady()
  return renderToString(app)
}

const signedOut: Load<Me | null> = { state: 'ready', data: null }
const signedIn: Load<Me | null> = { state: 'ready', data: person }

describe('routes', () => {
  it('serves sign-in and invites as public pages', () => {
    const router = makeRouter(createMemoryHistory())
    expect(router.resolve('/sign-in?next=/x').meta.public).toBe(true)
    expect(router.resolve(`/invite/${TOKEN}`)).toMatchObject({
      name: 'invite',
      params: { token: TOKEN },
      meta: { public: true },
    })
    expect(router.resolve('/').meta.public).toBeUndefined()
  })
})

describe('SignInView', () => {
  it('renders the sign-in form outside the workspace shell', async () => {
    const html = await render(SignInView, '/sign-in?next=/w/w1/hubs/h1', signedOut)
    expect(html).toContain('<h1')
    expect(html).toContain('Sign in')
    expect(html).toMatch(/<label[^>]*>Email<\/label>/)
    expect(html).toMatch(/<label[^>]*>Password<\/label>/)
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toMatch(/<button[^>]*type="submit"/)
    expect(html).toContain('Ask an owner or admin')
  })
})

describe('ShellUser', () => {
  it('shows the signed-in name and avatar, and a sign-out button', async () => {
    const html = await render(ShellUser, '/', signedIn)
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('<svg')
    expect(html).toMatch(/<button[^>]*>(<!--\[-->)?\s*Sign out\s*(<!--\]-->)?<\/button>/)
  })

  it('offers sign-in, coming back here, when signed out', async () => {
    const html = await render(ShellUser, '/w/w1/hubs/h1', signedOut)
    expect(html).toMatch(/<a [^>]*href="\/sign-in\?next=\/w\/w1\/hubs\/h1"[^>]*>Sign in<\/a>/)
    expect(html).not.toContain('Sign out')
  })

  it('renders loading and error inline', async () => {
    expect(await render(ShellUser, '/', { state: 'loading' })).toContain('data-state="loading"')
    const error = new ApiRequestError('internal', 'Down', 500)
    expect(await render(ShellUser, '/', { state: 'error', error })).toContain('data-state="error"')
  })
})

describe('InviteView', () => {
  const at = `/invite/${TOKEN}`

  it('says a malformed invite link is not valid, without asking for details', async () => {
    const html = await render(InviteView, '/invite/short', signedOut)
    expect(html).toContain('This invite is not valid')
    expect(html).toContain('data-invite="not-found"')
    expect(html).not.toContain('<form')
  })

  it('asks a signed-out visitor for a new account, or to sign in first', async () => {
    const html = await render(InviteView, at, signedOut)
    expect(html).toContain('data-invite="new-account"')
    expect(html).toMatch(/<label[^>]*>Name<\/label>/)
    expect(html).toMatch(/<label[^>]*>Email<\/label>/)
    expect(html).toContain('autocomplete="new-password"')
    expect(html).toContain('At least 12 characters.')
    expect(html).toContain('Create account and join')
    expect(html).toContain(`href="/sign-in?next=/invite/${TOKEN}"`)
  })

  it('offers a signed-in person to join as themselves, or sign out', async () => {
    const html = await render(InviteView, at, signedIn)
    expect(html).toContain('data-invite="existing-account"')
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('ada@example.com')
    expect(html).toContain('Accept invite')
    expect(html).not.toContain('autocomplete="new-password"')
    expect(html).toMatch(/<button[^>]*>(<!--\[-->)?\s*Sign out\s*(<!--\]-->)?<\/button>/)
  })

  it('renders loading and error while the session is checked', async () => {
    expect(await render(InviteView, at, { state: 'loading' })).toContain('Checking your session')
    const error = new ApiRequestError('network', 'The server could not be reached.')
    const html = await render(InviteView, at, { state: 'error', error })
    expect(html).toContain('Your session could not be checked')
    expect(html).toContain('Try again')
  })
})
