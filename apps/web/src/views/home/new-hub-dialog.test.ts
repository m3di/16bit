// @vitest-environment client-node
import type { CreateHub } from '@16bit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAll, fire, mount, setLayout, type, type FakeNode } from '../../test/fake-dom.ts'
import { PREFIX_TAKEN, type CreateHubResult } from './newHub.ts'
import NewHubDialog from './NewHubDialog.vue'

// issue 177: a prefix another hub in the workspace has (409 prefix_taken, D56) shows on the
// ID prefix field, not as a notice under the form, and the dialog stays open to fix it.

beforeEach(() => {
  // BaseDialog opens a native modal <dialog> and remembers the focused element.
  vi.stubGlobal('HTMLElement', function HTMLElement() {})
  vi.stubGlobal('document', { activeElement: null, body: {} })
  setLayout((el) => {
    if (el.tag !== 'dialog') return
    Object.assign(el, {
      open: false,
      showModal: () => Object.assign(el, { open: true }),
      close: () => Object.assign(el, { open: false }),
    })
  })
})

afterEach(() => {
  setLayout(null)
  vi.unstubAllGlobals()
})

const textOf = (n: FakeNode): string =>
  n.tag === '#comment' ? '' : n.text + n.children.map(textOf).join('')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function mountDialog(answers: CreateHubResult[]) {
  const sent: CreateHub[] = []
  const created: unknown[] = []
  const { root } = mount(NewHubDialog, {
    open: true,
    workspaceName: 'Parcel Tracker',
    create: (body: CreateHub) => {
      sent.push(body)
      return Promise.resolve(answers.shift() ?? { ok: false, message: 'No answer' })
    },
    onCreated: (hub: unknown) => created.push(hub),
  })
  const input = (attr: string) => {
    const found = findAll(root, (n) => n.tag === 'input' && n.props[attr] !== undefined)[0]
    if (!found) throw new Error(`no input with ${attr}`)
    return found
  }
  const form = findAll(root, (n) => n.tag === 'form')[0]
  if (!form) throw new Error('no form')
  return {
    root,
    sent,
    created,
    name: () => input('data-hub-name'),
    prefix: () => input('data-hub-prefix'),
    submit: async () => {
      fire(form, 'submit', { preventDefault: () => undefined })
      await flush()
    },
    notice: () => findAll(root, (n) => n.props['data-new-hub-error'] !== undefined),
  }
}

describe('NewHubDialog with a taken prefix', () => {
  it('shows the refusal on the prefix field and clears it when the prefix changes', async () => {
    const dialog = mountDialog([{ ok: false, message: PREFIX_TAKEN, field: 'idPrefix' }])
    type(dialog.name(), 'Engineering')
    type(dialog.prefix(), 'eng')
    await dialog.submit()

    expect(dialog.sent).toEqual([{ name: 'Engineering', color: 'indigo', idPrefix: 'ENG' }])
    expect(dialog.prefix().props['aria-invalid']).toBe('true')
    expect(textOf(dialog.root)).toContain(PREFIX_TAKEN)
    // On the field, not under the form, and nothing was created.
    expect(dialog.notice()).toEqual([])
    expect(dialog.created).toEqual([])
    expect(dialog.name().props['aria-invalid']).toBeUndefined()

    type(dialog.prefix(), 'eng2')
    await flush()
    expect(dialog.prefix().props['aria-invalid']).toBeUndefined()
    expect(textOf(dialog.root)).not.toContain(PREFIX_TAKEN)
  })

  it('still shows other refusals under the form', async () => {
    const dialog = mountDialog([{ ok: false, message: 'That hub ID is already used. Try again.' }])
    type(dialog.name(), 'Engineering')
    // The prefix follows the name once watchers run.
    await flush()
    expect(dialog.prefix().value).toBe('ENG')
    await dialog.submit()

    expect(dialog.prefix().props['aria-invalid']).toBeUndefined()
    expect(dialog.notice().map(textOf)).toEqual(['That hub ID is already used. Try again.'])
  })
})
