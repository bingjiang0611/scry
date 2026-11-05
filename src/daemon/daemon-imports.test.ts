import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from '../host-runtime/value-import-graph'

// The daemon runs on the App's Electron binary with ELECTRON_RUN_AS_NODE=1, so the
// binary is Electron but the runtime is plain Node: any reachable Electron API would
// throw at startup. Nothing here may import it, transitively or otherwise.
const ENTRY = resolve(__dirname, 'main.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')

describe('daemon entry has no Electron dependency', () => {
  it('never needs the electron runtime through a value import', () => {
    const { files, electron } = electronDependents(ENTRY)
    expect(files).toBeGreaterThan(2)
    expect(electron).toEqual([])
  })

  // The checker must be able to fail: Electron main imports it directly.
  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
