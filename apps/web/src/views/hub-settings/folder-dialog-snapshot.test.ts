// @vitest-environment client-node
import type { HubDescription } from '@16bit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { findAll, fire, mount, setLayout, type, type FakeNode } from '../../test/fake-dom.ts'
import { fakeApi, json } from '../hub/fixtures.test-utils.ts'
import FolderDialog from './FolderDialog.vue'
import { description, HUB, WS } from './fixtures.test-utils.ts'
import { useHubSettings } from './useHubSettings.ts'

// issue 233: the hub page reads the hub again live while a folder dialog is open. The dialog
// saves against the folder as it was when it opened, so a change made meanwhile is a 409 and a
// folder deleted meanwhile a 404, never an overwrite and never a new folder.

beforeEach(() => {
  vi.stubGlobal('HTMLElement', function HTMLElement() {})
  vi.stubGlobal('document', { activeElement: null, body: {} })
  setLayout((el) => {
    // v-model on a select reads its options when mounted; the parent choice is not tested here.
    if (el.tag === 'select') Object.assign(el, { options: [] })
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

const sprints = (d: HubDescription) => {
  const f = d.folders.find((x) => x.id === 'sprints')
  if (!f) throw new Error('fixture has no sprints folder')
  return f
}

function open(answer: () => Response) {
  const api = fakeApi((call) =>
    call.path === `/v1/workspaces/${WS}/hubs/${HUB}` ? json(description()) : answer(),
  )
  const model = useHubSettings(WS, HUB, api.fetchFn)
  const props = reactive({ open: true, description: description(), folderId: 'sprints', model })
  const { root } = mount(FolderDialog, props)
  const name = findAll(root, (n) => n.tag === 'input' && n.props['data-folder-name'] !== undefined)
  const form = findAll(root, (n) => n.tag === 'form')[0]
  if (!name[0] || !form) throw new Error('no form')
  const input = name[0]
  return {
    api,
    props,
    root,
    rename: (value: string) => {
      type(input, value)
    },
    save: async () => {
      fire(form, 'submit', { preventDefault: () => undefined })
      await flush()
      await flush()
    },
    writes: () => api.calls.filter((c) => c.method !== 'GET'),
  }
}

describe('FolderDialog while the page reads the hub again', () => {
  it('saves with the version it opened on, so their rename is a conflict', async () => {
    const before = sprints(description())
    const theirs = { ...before, name: 'Their name', version: before.version + 1 }
    const dialog = open(() => json({ error: 'conflict', message: 'Stale', current: theirs }, 409))
    // The live read brings their rename while the dialog is open.
    const fresh = description()
    fresh.folders = fresh.folders.map((f) => (f.id === 'sprints' ? theirs : f))
    dialog.props.description = fresh
    await flush()

    dialog.rename('Mine')
    await dialog.save()
    expect(dialog.writes()).toEqual([
      {
        method: 'PATCH',
        path: '/v1/workspaces/w1/folders/sprints',
        body: { version: before.version, name: 'Mine' },
      },
    ])
    expect(textOf(dialog.root)).toContain('Someone else changed this folder')
    expect(dialog.props.open).toBe(true)
  })

  it('never creates a folder when the one being edited was deleted meanwhile', async () => {
    const before = sprints(description())
    const dialog = open(() => json({ error: 'not_found', message: 'Not found' }, 404))
    const fresh = description()
    fresh.folders = fresh.folders.filter((f) => f.id !== 'sprints' && f.parentId !== 'sprints')
    dialog.props.description = fresh
    await flush()

    dialog.rename('Mine')
    await dialog.save()
    expect(dialog.writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ['PATCH', '/v1/workspaces/w1/folders/sprints', { version: before.version, name: 'Mine' }],
    ])
    expect(textOf(dialog.root)).toContain('This folder is no longer available.')
    expect(dialog.props.open).toBe(true)
  })
})
