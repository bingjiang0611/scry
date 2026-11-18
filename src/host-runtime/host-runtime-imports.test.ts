import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

// P3's first step: the host assembly must be able to run outside Electron. That is
// only true if nothing it imports — transitively, through relative imports — needs
// the `electron` runtime. Type-only imports are erased before the module runs, so
// they do not count; a value import that grows out of a type import would.
const ENTRY = resolve(__dirname, 'host-runtime.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/bootstrap/remote-host.ts')
describe('host runtime has no Electron dependency', () => {
  it('never needs the electron runtime through a value import', () => {
    const { files, electron } = electronDependents(ENTRY)
    // A graph of only the entry would make this assertion meaningless.
    expect(files).toBeGreaterThan(20)
    expect(electron).toEqual([])
  })

  // The checker must be able to fail: Electron main imports it directly.
  it('detects Electron in a module that really imports it', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
