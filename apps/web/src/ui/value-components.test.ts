import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ActorChip from './ActorChip.vue'
import AuthLayout from './AuthLayout.vue'
import CheckboxField from './CheckboxField.vue'
import ChipList from './ChipList.vue'
import RelationChip from './RelationChip.vue'
import RichTextEditor from './RichTextEditor.vue'
import RichTextView from './RichTextView.vue'
import SignInForm from './SignInForm.vue'
import UrlLink from './UrlLink.vue'
import ValueState from './ValueState.vue'

async function render(c: Component, props: Record<string, unknown> = {}) {
  const app = createSSRApp({ render: () => h(c, props) })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  })
  app.use(router)
  await router.push('/')
  return renderToString(app)
}

const options = [
  { id: 'web', label: 'Web', color: 'blue' },
  { id: 'api', label: 'API' },
]

describe('ValueState', () => {
  it.each([
    ['loading', 'data-state="loading"'],
    ['empty', 'Empty'],
    ['error', 'Could not load'],
    ['no-permission', 'No access'],
  ])('renders %s with text', async (state, text) => {
    expect(await render(ValueState, { state })).toContain(text)
  })

  it('is not a live region while loading, so a table of cells stays quiet', async () => {
    const html = await render(ValueState, { state: 'loading', label: 'Loading Done' })
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Loading Done')
  })
})

describe('CheckboxField', () => {
  it('is a native checkbox tied to its label', async () => {
    const html = await render(CheckboxField, { label: 'Done', modelValue: true })
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain('type="checkbox"')
    expect(html).toContain(`<label for="${String(id)}"`)
    expect(html).toContain('checked')
  })

  it('marks errors and describes them', async () => {
    const html = await render(CheckboxField, { label: 'Done', error: 'Could not save' })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toMatch(/aria-describedby="[^"]+-error"/)
  })

  it('is read-only with a reason when the reader cannot edit', async () => {
    const html = await render(CheckboxField, { label: 'Done', state: 'no-permission' })
    expect(html).toContain('disabled')
    expect(html).toContain('You can view this but not change it.')
  })

  it('shows a placeholder while loading', async () => {
    const html = await render(CheckboxField, { label: 'Done', state: 'loading' })
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('Loading Done')
  })

  it('shows a load failure with no box to tick', async () => {
    const html = await render(CheckboxField, { label: 'Done', state: 'error', error: 'x' })
    expect(html).not.toContain('<input')
    expect(html).toContain('Done')
    expect(html).toContain('Could not load')
    expect(html).not.toContain('aria-invalid')
  })
})

describe('ChipList', () => {
  it('renders a labelled list of chips', async () => {
    const html = await render(ChipList, { value: ['web', 'api'], options, label: 'Platforms' })
    expect(html).toContain('<ul aria-label="Platforms"')
    expect(html).toContain('var(--pal-blue-tint)')
    expect(html).toContain('API')
  })

  it('gives each chip a named remove button when removable', async () => {
    const html = await render(ChipList, {
      value: ['web'],
      options,
      label: 'Platforms',
      removable: true,
    })
    expect(html).toContain('<button type="button" aria-label="Remove Web"')
  })

  it('counts and names hidden chips past the limit', async () => {
    const html = await render(ChipList, {
      value: ['web', 'api'],
      options,
      label: 'Platforms',
      limit: 1,
    })
    expect(html).toContain('+1')
    expect(html).toContain('more: API')
  })

  it.each([
    [{ value: [] }, 'Empty'],
    [{ value: [], state: 'no-permission' }, 'No access'],
    [{ value: [], state: 'error' }, 'Could not load'],
    [{ value: [], state: 'loading' }, 'data-state="loading"'],
  ])('renders states: %j', async (props, text) => {
    expect(await render(ChipList, { options, label: 'Platforms', ...props })).toContain(text)
  })
})

describe('UrlLink', () => {
  it('links web addresses in a new tab without an opener', async () => {
    const html = await render(UrlLink, { value: 'https://example.com/a' })
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('opens in a new tab')
  })

  it('never links unsafe schemes', async () => {
    const html = await render(UrlLink, { value: 'javascript:alert(1)' })
    expect(html).not.toContain('<a')
    expect(html).toContain('javascript:alert(1)')
  })

  it('is empty without a value', async () => {
    expect(await render(UrlLink, { value: ' ' })).toContain('Empty')
  })
})

describe('ActorChip', () => {
  it('shows the avatar and name, and marks agents in text', async () => {
    const html = await render(ActorChip, { actor: { id: 'qa', name: 'qa-agent', kind: 'agent' } })
    expect(html).toContain('<svg')
    expect(html).toContain('qa-agent')
    expect(html).toContain('Agent')
  })

  it('does not label people as agents', async () => {
    const html = await render(ActorChip, { actor: { id: 's', name: 'Sara', kind: 'person' } })
    expect(html).not.toContain('Agent')
  })

  it.each([
    [{ actor: null }, 'Empty'],
    [{ actor: null, state: 'no-permission' }, 'No access'],
    [{ actor: null, state: 'error' }, 'Could not load'],
    [{ actor: null, state: 'loading' }, 'data-state="loading"'],
  ])('renders states: %j', async (props, text) => {
    expect(await render(ActorChip, props)).toContain(text)
  })
})

describe('RelationChip', () => {
  it('links a readable target with its ID', async () => {
    const html = await render(RelationChip, {
      target: { access: 'ok', id: 'i1', title: 'Notifications', displayId: 'PT-12' },
      to: '/items/i1',
    })
    expect(html).toContain('href="/items/i1"')
    expect(html).toContain('PT-12')
    expect(html).toContain('Notifications')
  })

  it('shows "No access" for a hidden target, never as a link', async () => {
    const html = await render(RelationChip, { target: { access: 'none', id: 'i3' }, to: '/x' })
    expect(html).toContain('No access')
    expect(html).toContain('a linked item you cannot see')
    expect(html).not.toContain('<a')
  })

  it.each([
    [{ target: null }, 'Empty'],
    [{ target: null, state: 'error' }, 'Could not load'],
    [{ target: null, state: 'loading' }, 'data-state="loading"'],
  ])('renders states: %j', async (props, text) => {
    expect(await render(RelationChip, props)).toContain(text)
  })
})

describe('RichTextView', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi ' },
          { type: 'text', text: 'there', marks: [{ type: 'bold' }] },
          {
            type: 'text',
            text: 'bad',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          },
          {
            type: 'text',
            text: 'docs',
            marks: [{ type: 'link', attrs: { href: 'https://16bit.info/docs' } }],
          },
        ],
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Title' }] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
          },
        ],
      },
    ],
  }

  it('renders the node set as real elements', async () => {
    const html = await render(RichTextView, { doc, label: 'Description' })
    expect(html).toContain('role="region"')
    expect(html).toContain('<strong')
    expect(html).toContain('<h3')
    expect(html).toContain('<ul')
    expect(html).not.toContain('javascript:')
  })

  it('links safe addresses in a new tab and says so to screen readers', async () => {
    const html = await render(RichTextView, { doc })
    expect(html).toContain('href="https://16bit.info/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toMatch(/<a [^>]*>docs<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/)
  })

  it('escapes text instead of rendering it as markup', async () => {
    const html = await render(RichTextView, {
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '<img src=x>' }] }],
      },
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it.each([
    [{ doc: null }, 'Empty'],
    [{ doc: null, state: 'no-permission' }, 'No access'],
    [{ doc: null, state: 'error' }, 'Could not load'],
  ])('renders states: %j', async (props, text) => {
    expect(await render(RichTextView, props)).toContain(text)
  })
})

describe('RichTextEditor', () => {
  it('has a labelled toolbar of toggle buttons with one tab stop', async () => {
    const html = await render(RichTextEditor, { label: 'Description' })
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Description formatting"')
    expect(html).toContain('aria-label="Bold"')
    expect(html).toContain('aria-pressed="false"')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  })

  it('shows the document read-only without the toolbar when the reader cannot edit', async () => {
    const html = await render(RichTextEditor, {
      label: 'Description',
      state: 'no-permission',
      modelValue: 'Hello',
    })
    expect(html).not.toContain('role="toolbar"')
    expect(html).toContain('Hello')
    expect(html).toContain('You can view this but not change it.')
  })

  it('shows errors under the editor', async () => {
    const html = await render(RichTextEditor, { label: 'Description', error: 'Could not save' })
    expect(html).toContain('Could not save')
    expect(html).toContain('border-danger')
  })

  it('shows a placeholder while loading', async () => {
    const html = await render(RichTextEditor, { label: 'Description', state: 'loading' })
    expect(html).toContain('data-state="loading"')
    expect(html).not.toContain('role="toolbar"')
  })

  it('shows a load failure with no editor to type into', async () => {
    const html = await render(RichTextEditor, {
      label: 'Description',
      state: 'error',
      modelValue: 'Hello',
    })
    expect(html).toContain('Could not load')
    expect(html).not.toContain('role="toolbar"')
    expect(html).not.toContain('role="textbox"')
    expect(html).not.toContain('Hello')
  })
})

describe('SignInForm', () => {
  it('uses labelled email and password inputs with autocomplete hints', async () => {
    const html = await render(SignInForm)
    expect(html).toContain('type="email"')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('type="submit"')
    expect(html).not.toContain('role="alert"')
  })

  it('locks the form while submitting', async () => {
    const html = await render(SignInForm, { state: 'submitting' })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Signing in')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('does not reveal which credential was wrong', async () => {
    const html = await render(SignInForm, { state: 'error' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('That email and password do not match.')
  })

  it('explains a refused account', async () => {
    const html = await render(SignInForm, { state: 'no-permission', message: 'Account disabled.' })
    expect(html).toContain('Account disabled.')
    expect(html).toContain('data-tone="info"')
    expect(html).toContain('role="status"')
  })
})

describe('AuthLayout', () => {
  it('has one h1 and a main landmark', async () => {
    const html = await render(AuthLayout, { title: 'Sign in' })
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('<main')
  })
})
