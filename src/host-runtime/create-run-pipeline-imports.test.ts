import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

// M2-4 gives the run pipeline an assembly entry that does not need Electron, so the
// daemon can build the same pipeline with its own renderer sink and path getters.
const ENTRY = resolve(__dirname, 'create-run-pipeline.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')

describe('run pipeline assembly has no Electron dependency', () => {
  it('exists and never needs the electron runtime through a value import', () => {
    expect(existsSync(ENTRY)).toBe(true)
    const { files, electron } = electronDependents(ENTRY)
    // A graph of only the entry would make this assertion meaningless.
    expect(files).toBeGreaterThan(5)
    expect(electron).toEqual([])
  })

  // The checker must be able to fail: Electron main imports electron directly.
  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
