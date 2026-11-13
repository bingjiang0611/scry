import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { catalogue, checkCatalogue } from './performance-path-catalogue.mjs'

describe('modular performance path catalogue', () => {
  it('keeps the original path order and all workbench metadata', () => {
    expect(catalogue.paths.map(path => path.id)).toEqual(["startup","providers","navigation","history","compose","send","stream","controls","persistence","evidence","analytics","workspace","source-control","terminal","remote","resources-shell"])
    const workbench = JSON.parse(readFileSync(new URL('./performance-paths/workbench.json', import.meta.url), 'utf8'))
    expect(catalogue.paths.filter(path => ['workspace', 'source-control'].includes(path.id))).toEqual(workbench)
    expect(checkCatalogue()).toBe(catalogue)
  })
})
