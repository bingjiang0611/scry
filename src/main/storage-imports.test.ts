import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from '../host-runtime/value-import-graph'

// B3-M1: storage decides where it lives from an injected root, not from Electron.
// These modules are the ones the daemon must load without an `app` object, so each
// one's own value-import graph has to stay free of the electron runtime.
const STORAGE_MODULES = [
  'db.ts',
  'app-store.ts',
  'bootstrap/remote-history.ts',
  'mcp-execution-trust.ts'
].map((entry) => resolve(__dirname, entry))

// Electron main is the module that really does import electron; if the checker
// cannot see it there, "no electron" below would pass for the wrong reason.
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')

describe('storage modules load without Electron', () => {
  for (const entry of STORAGE_MODULES) {
    it(`${entry.replace(`${resolve(__dirname)}/`, '')} has no value import of electron`, () => {
      const { files, electron } = electronDependents(entry)
      expect(files).toBeGreaterThan(0)
      expect(electron).toEqual([])
    })
  }

  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
