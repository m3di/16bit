import { describe, expect, it } from 'vitest'

// A template ref must not share its name with an import or a function of the same component. In
// the production build, templates are compiled inline with `<script setup>`, so `ref="name"`
// beside `import { name }` becomes a function ref that calls the import on every render. The
// dev server compiles templates apart and never shows it (issue 233: the sidebar's folder menus
// did nothing in the built app, and threw inside `folderActions`).
const sources = import.meta.glob<string>('../**/*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Names a `<script setup>` imports or declares as functions. */
function callableBindings(source: string): Set<string> {
  const script = /<script setup[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? ''
  const names = new Set<string>()
  for (const [, clause = ''] of script.matchAll(/^import\s+(?!type\b)([\s\S]*?)\s+from\s/gm)) {
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ''
    const defaultName = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim()
    if (/^\w+$/.test(defaultName)) names.add(defaultName)
    for (const part of named.split(',')) {
      const item = part.trim()
      if (!item || item.startsWith('type ')) continue
      names.add(item.split(/\s+as\s+/).pop() ?? item)
    }
  }
  for (const [, name = ''] of script.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) names.add(name)
  return names
}

/** Static `ref="name"` attributes in the template. */
function templateRefs(source: string): string[] {
  const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
  return [...template.matchAll(/\sref="(\w+)"/g)].map((m) => m[1] ?? '')
}

describe('template refs', () => {
  it('reads the bindings and refs it checks', () => {
    const sfc = `<script setup lang="ts">
import FolderActions from './FolderActions.vue'
import { folderActions, type FolderActionKey } from './schema.ts'
import { a as b } from 'x'
function run() {}
const box = useTemplateRef('box')
</script>
<template><FolderActions ref="folderActions" /><div ref="box" /></template>`
    expect([...callableBindings(sfc)].sort()).toEqual([
      'FolderActions',
      'b',
      'folderActions',
      'run',
    ])
    expect(templateRefs(sfc)).toEqual(['folderActions', 'box'])
  })

  it('found the components', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5)
  })

  it.each(Object.entries(sources))('%s names no ref after an import or function', (_, source) => {
    const callable = callableBindings(source)
    expect(templateRefs(source).filter((name) => callable.has(name))).toEqual([])
  })
})
