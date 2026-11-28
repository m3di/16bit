import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import BaseSelect from './BaseSelect.vue'
import FormNotice from './FormNotice.vue'
import PixelAvatar from './PixelAvatar.vue'
import PlusGlyph from './PlusGlyph.vue'
import SizeMeter from './SizeMeter.vue'
import StateBlock from './StateBlock.vue'
import StatusDot from './StatusDot.vue'

const render = (c: Component, props: Record<string, unknown> = {}, slot?: string) =>
  renderToString(createSSRApp({ render: () => h(c, props, slot ? () => slot : undefined) }))

describe('components', () => {
  it('Button is a native button that does not submit by default', async () => {
    const html = await render(BaseButton, {}, 'Save')
    expect(html).toMatch(/^<button type="button"/)
    expect(html).not.toContain('data-button-icon')
  })

  it('Button puts a leading icon before its text, hidden from the accessible name', async () => {
    const html = (
      await renderToString(
        createSSRApp({
          render: () =>
            h(BaseButton, null, { icon: () => h(PlusGlyph), default: () => 'New item' }),
        }),
      )
    ).replace(/<!--.*?-->/g, '')
    expect(html).toMatch(
      /^<button type="button"[^>]*><span aria-hidden="true"[^>]*data-button-icon><svg aria-hidden="true" focusable="false"[^>]*data-glyph="plus"/,
    )
    // Everything outside aria-hidden is the name: the text alone.
    const visibleText = html
      .replace(/<span aria-hidden="true".*?<\/span>/, '')
      .replace(/<[^>]+>/g, '')
    expect(visibleText).toBe('New item')
  })

  it('Input ties its label, hint, and error to the input', async () => {
    const html = await render(BaseInput, { label: 'Name', hint: 'Short', error: 'Required' })
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`<label for="${String(id)}"`)
    expect(html).toContain(`aria-describedby="${String(id)}-hint ${String(id)}-error"`)
    expect(html).toContain('aria-invalid="true"')
  })

  it('Select is a native select with a label', async () => {
    const html = await render(BaseSelect, {
      label: 'Role',
      options: [{ value: 'a', label: 'A' }],
    })
    const id = /<select[^>]* id="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`<label for="${String(id)}"`)
    expect(html).toContain('<option value="a"')
  })

  it('StatusDot always shows its label', async () => {
    expect(await render(StatusDot, { label: 'Active now', tone: 'success' })).toContain(
      'Active now',
    )
  })

  it('Avatar is hidden from assistive tech unless labelled', async () => {
    expect(await render(PixelAvatar, { id: 'sara' })).toContain('aria-hidden="true"')
    const labelled = await render(PixelAvatar, { id: 'sara', label: 'Sara' })
    expect(labelled).toContain('role="img"')
    expect(labelled).toContain('aria-label="Sara"')
  })

  it('SizeMeter states its level in text', async () => {
    const html = await render(SizeMeter, { count: 412 })
    expect(html).toContain('aria-label="Size: 3 of 4"')
  })

  it('SizeMeter fills no squares for an empty hub', async () => {
    const html = await render(SizeMeter, { count: 0 })
    expect(html).toContain('aria-label="Size: 0 of 4"')
    expect(html).not.toContain('background')
  })

  it.each([
    ['loading', 'role="status"'],
    ['empty', 'Nothing here yet'],
    ['error', 'role="alert"'],
    ['no-permission', 'You do not have access'],
    ['not-found', 'This could not be found'],
  ])('StateBlock renders the %s state', async (state, expected) => {
    expect(await render(StateBlock, { state })).toContain(expected)
  })

  it('StateBlock keeps not found apart from empty and no permission', async () => {
    const html = await render(StateBlock, { state: 'not-found' })
    expect(html).toContain('data-state="not-found"')
    expect(html).not.toContain('role="alert"')
    // A hidden thing answers 404 like a missing one, so the default never says it is gone.
    expect(html).not.toMatch(/does not exist/i)
    const glyph = (h: string) => /<span aria-hidden="true" class="([^"]+)"/.exec(h)?.[1]
    const others = await Promise.all(
      (['empty', 'no-permission'] as const).map((state) => render(StateBlock, { state })),
    )
    for (const other of others) expect(glyph(other)).not.toBe(glyph(html))
  })

  it('StateBlock not found takes a title and message', async () => {
    const html = await render(StateBlock, {
      state: 'not-found',
      title: 'This hub is not available',
      message: 'It may not exist, or it may not be shared with you.',
    })
    expect(html).toContain('This hub is not available')
    expect(html).toContain('It may not exist, or it may not be shared with you.')
    expect(html).not.toContain('This could not be found')
  })

  it('FormNotice is an alert by default, in the danger colour', async () => {
    const html = await render(FormNotice, {}, 'The invite was not accepted.')
    expect(html).toMatch(/<p role="alert"[^>]*text-danger/)
    expect(html).toContain('data-tone="error"')
    expect(html).toContain('The invite was not accepted.')
  })

  it('FormNotice info is a polite status in secondary ink', async () => {
    const html = await render(FormNotice, { tone: 'info' }, 'Ask an owner for an invite.')
    expect(html).toMatch(/<p role="status"[^>]*text-ink2/)
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('text-danger')
  })

  it('FormNotice keeps its action outside the live region', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(FormNotice, null, {
            default: () => 'Saving failed.',
            action: () => h(BaseButton, null, () => 'Dismiss'),
          }),
      }),
    )
    const alert = /<p role="alert"[\s\S]*?<\/p>/.exec(html)?.[0] ?? ''
    expect(alert).toContain('Saving failed.')
    expect(alert).not.toContain('Dismiss')
    expect(html).toContain('Dismiss')
  })
})
