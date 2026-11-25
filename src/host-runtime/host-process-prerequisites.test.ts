import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

const ENTRIES = [
  '../main/bootstrap/session-state.ts',
  '../main/bootstrap/session-catalog.ts',
  '../main/bootstrap/provider-runtime.ts'
]
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')

describe('host process prerequisites have no Electron value dependency', () => {
  for (const entry of ENTRIES) {
    it(`${entry} is injectable`, () => {
      const absolute = resolve(__dirname, entry)
      const { files, electron } = electronDependents(absolute)
      expect(files).toBeGreaterThan(1)
      expect(electron).toEqual([])
    })
  }

  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
