import { describe, expect, it } from 'vitest'
import { folderItemsOpener } from './folderItems.ts'

function opener(mayHaveItems: (id: string) => boolean = () => true) {
  const opened: string[] = []
  const show = folderItemsOpener((id) => opened.push(id), mayHaveItems)
  return { opened, show }
}

describe('folderItemsOpener', () => {
  it('reads a folder’s items while its view loads, once, so no view request comes first', () => {
    const { opened, show } = opener()
    show('b', 'loading')
    expect(opened).toEqual(['b'])
    // The view says there is none stored: the items already read are the folder screen's.
    show('b', 'default')
    expect(opened).toEqual(['b'])
  })

  it('leaves the items read early unused when the folder has a stored view', () => {
    const { opened, show } = opener()
    show('b', 'loading')
    show('b', 'view')
    expect(opened).toEqual(['b'])
    // The view is reset later: the folder screen reads its items then.
    show('b', 'default')
    expect(opened).toEqual(['b', 'b'])
  })

  it('waits for the view of a folder that may have no items', () => {
    const { opened, show } = opener((id) => id !== 'home')
    show('home', 'loading')
    show('home', 'view')
    expect(opened).toEqual([])
  })

  it('reads them when the folder becomes known while its view is still loading', () => {
    let known = false
    const { opened, show } = opener(() => known)
    show('b', 'loading')
    known = true
    show('b', 'loading')
    show('b', 'loading')
    expect(opened).toEqual(['b'])
  })

  it('reads each folder opened, and not again while one stays on its folder screen', () => {
    const { opened, show } = opener((id) => id !== 'sp')
    show('b', 'default')
    show('b', 'default')
    show('sp', 'loading')
    show('sp', 'default')
    show('a', 'loading')
    show('a', 'error')
    expect(opened).toEqual(['b', 'sp', 'a'])
  })
})
