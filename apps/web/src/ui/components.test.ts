import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import BaseSelect from './BaseSelect.vue'
import PixelAvatar from './PixelAvatar.vue'
import SizeMeter from './SizeMeter.vue'
import StateBlock from './StateBlock.vue'
import StatusDot from './StatusDot.vue'

const render = (c: Component, props: Record<string, unknown> = {}, slot?: string) =>
  renderToString(createSSRApp({ render: () => h(c, props, slot ? () => slot : undefined) }))

describe('components', () => {
  it('Button is a native button that does not submit by default', async () => {
    const html = await render(BaseButton, {}, 'Save')
    expect(html).toMatch(/^<button type="button"/)
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
  ])('StateBlock renders the %s state', async (state, expected) => {
    expect(await render(StateBlock, { state })).toContain(expected)
  })
})
