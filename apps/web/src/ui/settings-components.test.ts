import { createSSRApp, h, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import AttributeTypePicker from './AttributeTypePicker.vue'
import BaseDialog from './BaseDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import OptionsEditor from './OptionsEditor.vue'
import PalettePicker from './PalettePicker.vue'
import RowActionsMenu from './RowActionsMenu.vue'
import SettingsLayout from './SettingsLayout.vue'
import SettingsSection from './SettingsSection.vue'
import TabList from './TabList.vue'
import ToggleSwitch from './ToggleSwitch.vue'

// Server rendering checks the markup screen readers and the keyboard rely on: native elements,
// roles, names, and which states render a control at all. Key handling is covered by the pure
// helpers (settings.test.ts) and by e2e/tests/kit-settings.spec.ts in a real browser.

type Slots = Record<string, () => unknown>
const render = (c: Component, props: Record<string, unknown> = {}, slots?: Slots) =>
  renderToString(createSSRApp({ render: () => h(c, props, slots) }))

async function renderRouted(c: Component, props: Record<string, unknown>, slots?: Slots) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  })
  await router.push('/s/access')
  const app = createSSRApp({ render: () => h(c, props, slots) })
  app.use(router)
  return renderToString(app)
}

const count = (html: string, text: string) => html.split(text).length - 1
const checkedRadios = (html: string) =>
  (html.match(/<input type="radio"[^>]* checked[ >]/g) ?? []).length

describe('ToggleSwitch', () => {
  it('is a button with role switch, named by its visible label', async () => {
    const html = await render(ToggleSwitch, {
      label: 'Relations to other hubs',
      description: 'Off: items here cannot link to items in another hub.',
      modelValue: false,
    })
    expect(html).toMatch(/<button[^>]*type="button"[^>]*role="switch"[^>]*aria-checked="false"/)
    const labelId = /<span id="([^"]+)"[^>]*>Relations to other hubs</.exec(html)?.[1]
    expect(html).toContain(`aria-labelledby="${String(labelId)}"`)
    expect(html).toContain('aria-describedby=')
    // Off uses --line3, which keeps 3:1 on the page.
    expect(html).toContain('bg-line3')
  })

  it('takes an aria-label when its label is hidden, as in a table cell', async () => {
    const html = await render(ToggleSwitch, {
      label: 'Filter and sort by Stage',
      labelHidden: true,
      modelValue: true,
    })
    expect(html).toContain('aria-label="Filter and sort by Stage"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('bg-accent')
  })

  it.each(['loading', 'error'])('renders no switch while %s', async (state) => {
    const html = await render(ToggleSwitch, { label: 'Indexed', state })
    expect(html).not.toContain('role="switch"')
    expect(html).toContain(`data-state="${state}"`)
  })

  it('is read-only with the reason when the reader cannot change it', async () => {
    const html = await render(ToggleSwitch, {
      label: 'Indexed',
      state: 'no-permission',
      reason: 'Only hub admins change this.',
    })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('Only hub admins change this.')
  })
})

describe('PalettePicker', () => {
  it('is a labelled group of 16 native radios with colour names', async () => {
    const html = await render(PalettePicker, { label: 'Colour', modelValue: 'indigo' })
    const labelId = /<span id="([^"]+)"[^>]*>Colour</.exec(html)?.[1]
    expect(html).toContain(`role="radiogroup" aria-labelledby="${String(labelId)}"`)
    expect(count(html, 'type="radio"')).toBe(16)
    expect(html).toContain('aria-label="Indigo"')
    expect(html).toContain('aria-label="Grey"')
    // Exactly one checked, with a mark beside the outline so selection is not colour alone.
    expect(checkedRadios(html)).toBe(1)
    expect(count(html, 'data-checked-mark')).toBe(1)
  })

  it('offers "No colour" when the colour is optional, and checks nothing when empty', async () => {
    const html = await render(PalettePicker, { label: 'Colour', allowNone: true, modelValue: null })
    expect(count(html, 'type="radio"')).toBe(17)
    expect(html).toContain('aria-label="No colour"')
    const empty = await render(PalettePicker, { label: 'Colour' })
    expect(checkedRadios(empty)).toBe(0)
  })

  it('never uses a raw colour: swatches read the palette variables', async () => {
    const html = await render(PalettePicker, { label: 'Colour', modelValue: 'teal' })
    expect(html).toContain('var(--pal-teal)')
  })

  it.each(['loading', 'error'])('renders no radios while %s', async (state) => {
    expect(await render(PalettePicker, { label: 'Colour', state })).not.toContain('type="radio"')
  })

  it('shows the colour by name, read-only, without permission', async () => {
    const html = await render(PalettePicker, {
      label: 'Colour',
      modelValue: 'violet',
      state: 'no-permission',
    })
    expect(html).not.toContain('type="radio"')
    expect(html).toContain('Violet')
    expect(html).toContain('You can view this but not change it.')
  })
})

describe('AttributeTypePicker', () => {
  it('is a fieldset of native radios with a legend and a hint on each', async () => {
    const html = await render(AttributeTypePicker, { modelValue: 'select' })
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Type<\/legend>/)
    expect(count(html, 'type="radio"')).toBe(11)
    expect(html).toContain('Multi-select')
    const hintId = /value="select"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`id="${String(hintId)}"`)
  })

  it('shows a fixed type as text with the reason (D51)', async () => {
    const html = await render(AttributeTypePicker, { modelValue: 'relation', locked: true })
    expect(html).not.toContain('type="radio"')
    expect(html).toContain('Relation')
    expect(html).toContain('add a new attribute')
  })

  it('ties a validation error to the group', async () => {
    const html = await render(AttributeTypePicker, { error: 'Choose a type.' })
    const id = /<span id="([^"]+)"[^>]*>Choose a type\./.exec(html)?.[1]
    expect(html).toContain(`aria-describedby="${String(id)}"`)
    expect(html).toContain('aria-invalid="true"')
  })

  it.each(['loading', 'error', 'no-permission'])('renders no radios when %s', async (state) => {
    expect(await render(AttributeTypePicker, { state })).not.toContain('type="radio"')
  })
})

describe('TabList', () => {
  const tabs = [
    { key: 'general', label: 'General' },
    { key: 'options', label: 'Options' },
    { key: 'usage', label: 'Usage' },
  ]

  it('is a named tablist with one tab stop and one labelled panel', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(
            TabList,
            { label: 'Attribute settings', tabs, modelValue: 'options' },
            { default: () => 'Panel body' },
          ),
      }),
    )
    expect(html).toContain('role="tablist" aria-label="Attribute settings"')
    expect(count(html, 'role="tab"')).toBe(3)
    expect(count(html, 'tabindex="0"')).toBe(2) // the selected tab and the panel
    expect(count(html, 'aria-selected="true"')).toBe(1)
    const tabId = /<button id="([^"]+)"[^>]*aria-selected="true"/.exec(html)?.[1]
    const panelId = /aria-selected="true" aria-controls="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`id="${String(panelId)}" role="tabpanel"`)
    expect(html).toContain(`aria-labelledby="${String(tabId)}"`)
    expect(count(html, 'role="tabpanel"')).toBe(1)
    expect(html).toContain('Panel body')
  })
})

describe('BaseDialog', () => {
  it('is a native dialog named by its heading, with a labelled close button', async () => {
    const html = await render(
      BaseDialog,
      { open: true, title: 'New folder', description: 'Folders group items.' },
      { default: () => 'Body', footer: () => 'Footer' },
    )
    expect(html).toMatch(/^<dialog/)
    const titleId = /<h2 id="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`aria-labelledby="${String(titleId)}"`)
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('Body')
    // No shadow: a hairline border sets the dialog apart.
    expect(html).not.toMatch(/shadow/)
  })

  it.each(['loading', 'empty', 'error', 'no-permission', 'not-found'])(
    'shows a StateBlock instead of the body when %s',
    async (state) => {
      const html = await render(
        BaseDialog,
        { open: true, title: 'Folder', state },
        { default: () => 'Body' },
      )
      expect(html).not.toContain('Body')
      expect(html).toMatch(/role="status"|data-state=/)
    },
  )

  it('can be made to refuse closing', async () => {
    const open = await render(BaseDialog, { open: true, title: 'Saving' })
    expect(open).toMatch(/aria-label="Close"(?! disabled)/)
    const held = await render(BaseDialog, { open: true, title: 'Saving', persistent: true })
    expect(held).toMatch(/aria-label="Close" disabled/)
  })

  it('renders nothing inside while closed', async () => {
    const html = await render(BaseDialog, { title: 'New folder' }, { default: () => 'Body' })
    expect(html).not.toContain('Body')
  })
})

describe('ConfirmDialog', () => {
  it('keeps the action disabled until the name is typed', async () => {
    const html = await render(ConfirmDialog, {
      open: true,
      title: 'Delete Engineering?',
      confirmLabel: 'Delete hub',
      requireText: 'Engineering',
    })
    expect(html).toContain('Type Engineering to confirm')
    expect(html).toMatch(/<button type="submit" disabled[^>]*>(<!--\[-->)?Delete hub/)
    // The name field takes focus first.
    expect(html).toMatch(/<input[^>]*autofocus/)
  })

  it('without a name, focuses Cancel first and allows the action', async () => {
    const html = await render(ConfirmDialog, {
      open: true,
      title: 'Remove Kofi?',
      confirmLabel: 'Remove',
    })
    expect(html).toMatch(/<button type="button"[^>]*autofocus>(<!--\[-->)?Cancel/)
    expect(html).toMatch(/<button type="submit" (?!disabled)[^>]*>(<!--\[-->)?Remove/)
    expect(html).toContain('text-danger')
  })

  it.each([
    ['loading', 'role="status"'],
    ['error', 'role="alert"'],
    ['no-permission', 'You do not have access'],
    ['not-found', 'This hub is not available'],
  ])('shows the %s state instead of the form', async (state, expected) => {
    const html = await render(ConfirmDialog, {
      open: true,
      title: 'Delete hub?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete hub',
      requireText: 'Engineering',
      state,
      stateTitle: state === 'not-found' ? 'This hub is not available' : '',
    })
    expect(html).toContain(expected)
    expect(html).not.toContain('<form')
    expect(html).not.toContain('This cannot be undone.')
  })

  it('cannot be closed while busy', async () => {
    const html = await render(ConfirmDialog, {
      open: true,
      title: 'Delete Engineering?',
      confirmLabel: 'Delete hub',
      busy: true,
    })
    expect(html).toMatch(/<button type="button" aria-label="Close" disabled/)
    expect(html).toContain('aria-busy="true"')
  })

  it('shows why the action failed as an alert', async () => {
    const html = await render(ConfirmDialog, {
      open: true,
      title: 'Delete Engineering?',
      confirmLabel: 'Delete hub',
      error: 'The hub still holds items.',
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('The hub still holds items.')
  })
})

describe('RowActionsMenu', () => {
  const items = [
    { key: 'edit', label: 'Rename' },
    { key: 'remove', label: 'Remove', danger: true },
  ]

  it('is a closed menu button named for its row', async () => {
    const html = await render(RowActionsMenu, { label: 'Actions for Tomas', items })
    expect(html).toContain('aria-label="Actions for Tomas"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="menu"')
  })

  it('renders nothing without permission or without actions', async () => {
    expect(
      await render(RowActionsMenu, { label: 'Actions', items, state: 'no-permission' }),
    ).not.toContain('<button')
    expect(await render(RowActionsMenu, { label: 'Actions', items: [] })).not.toContain('<button')
  })

  it('waits while loading', async () => {
    const html = await render(RowActionsMenu, { label: 'Actions', items, state: 'loading' })
    expect(html).toMatch(/<button[^>]*disabled/)
    expect(html).toContain('aria-busy="true"')
  })

  it('still opens in the error state, to say why it is empty', async () => {
    const html = await render(RowActionsMenu, { label: 'Actions', items: [], state: 'error' })
    expect(html).toContain('aria-haspopup="menu"')
  })
})

describe('OptionsEditor', () => {
  const options = [
    { id: 'o1', label: 'Backlog', color: 'slate' },
    { id: 'o2', label: 'Done', color: 'green' },
    { id: 'o3', label: 'done' },
  ]

  it('lists each option with a named field, colour button, and actions', async () => {
    const html = await render(OptionsEditor, { modelValue: options, usage: { o2: 12 } })
    expect(html).toContain('<ol')
    expect(html).toContain('Name of option 1')
    expect(html).toContain('aria-label="Colour for option 2: Green"')
    expect(html).toContain('aria-label="Colour for option 3: No colour"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Actions for option 2, Done"')
    expect(html).toContain('12 items')
    // The clash is shown on the later option.
    expect(count(html, 'Another option has this name.')).toBe(1)
    expect(html).toContain('Add option')
  })

  it('outlines the colour button of an option with no colour, so it is never invisible', async () => {
    const html = await render(OptionsEditor, { modelValue: options })
    const button = (label: string) =>
      new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? ''
    const none = button('Colour for option 3: No colour')
    expect(none).toMatch(/class="[^"]*\bborder border-dashed border-line3\b/)
    expect(none).not.toContain('border-0')
    expect(button('Colour for option 2: Green')).toContain('border-0')
  })

  it('formats counts as the confirm does', async () => {
    const html = await render(OptionsEditor, { modelValue: options, usage: { o1: 1280, o2: 1 } })
    expect(html).toContain('1,280 items')
    expect(html).toContain('1 item<')
  })

  it('has an empty state that still offers Add option', async () => {
    const html = await render(OptionsEditor, { modelValue: [] })
    expect(html).toContain('No options yet')
    expect(html).toContain('Add option')
  })

  it.each([
    ['loading', 'role="status"'],
    ['error', 'Options could not load'],
  ])('shows a StateBlock and no fields when %s', async (state, expected) => {
    const html = await render(OptionsEditor, { modelValue: options, state })
    expect(html).toContain(expected)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('Add option')
  })

  it('shows chips, read-only, without permission', async () => {
    const html = await render(OptionsEditor, { modelValue: options, state: 'no-permission' })
    expect(html).not.toContain('<input')
    expect(html).toContain('var(--pal-green-tint)')
    expect(html).toContain('You can view these but not change them.')
  })
})

describe('SettingsSection', () => {
  it('is a region named by its heading', async () => {
    const html = await render(
      SettingsSection,
      { title: 'Folders', description: 'A folder can narrow who opens it.' },
      { default: () => 'Table', actions: () => 'New folder' },
    )
    const id = /<h2 id="([^"]+)"/.exec(html)?.[1]
    expect(html).toMatch(new RegExp(`<section aria-labelledby="${String(id)}"`))
    expect(html).toContain('New folder')
    expect(html).toContain('A folder can narrow who opens it.')
  })

  it('swaps the content and its actions for a state', async () => {
    const html = await render(
      SettingsSection,
      { title: 'Folders', state: 'error' },
      { default: () => 'Table', actions: () => 'New folder' },
    )
    expect(html).not.toContain('Table')
    expect(html).not.toContain('New folder')
    expect(html).toContain('role="alert"')
  })
})

describe('SettingsLayout', () => {
  const props = {
    trail: ['Parcel Tracker', 'Engineering', 'Hub settings'],
    back: { label: 'Back to Engineering', to: '/' },
    navLabel: 'Hub settings',
    sections: [
      { key: 'overview', label: 'Overview', to: '/s/overview' },
      { key: 'access', label: 'Access', to: '/s/access' },
      { key: 'danger', label: 'Danger zone', to: '/s/danger', danger: true },
    ],
    current: 'access',
    title: 'Engineering',
  }

  it('has a named section nav with the current page marked, and one h1', async () => {
    const html = await renderRouted(SettingsLayout, props, { default: () => 'Content' })
    expect(html).toContain('<nav aria-label="Hub settings"')
    expect(count(html, 'aria-current="page"')).toBe(1)
    expect(html).toMatch(/<a aria-current="page" href="\/s\/access"/)
    expect(html).toMatch(/<a href="\/s\/danger"[^>]*text-danger/)
    expect(count(html, '<h1')).toBe(1)
    expect(html).toContain('Parcel Tracker / Engineering / Hub settings')
    expect(html).toContain('Back to Engineering')
    expect(html).toContain('<main')
  })

  it('keeps the way back but drops the section nav for a hub that is not available', async () => {
    const html = await renderRouted(
      SettingsLayout,
      {
        ...props,
        title: 'Hub settings',
        state: 'not-found',
        stateTitle: 'This hub is not available',
      },
      { default: () => 'Content' },
    )
    expect(html).not.toContain('<nav')
    expect(html).not.toContain('Content')
    expect(html).toContain('This hub is not available')
    expect(html).toContain('Back to Engineering')
  })

  it('keeps the section nav while loading', async () => {
    const html = await renderRouted(
      SettingsLayout,
      { ...props, state: 'loading' },
      { default: () => 'Content' },
    )
    expect(html).toContain('<nav')
    expect(html).toContain('role="status"')
  })
})
