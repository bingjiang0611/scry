import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from '../../host-runtime/value-import-graph'

// M2 moves the run pipeline out of Electron so the daemon can host it. Paths come
// from the injected storage root, not from app.getPath, so none of these modules may
// need the electron runtime.
const PIPELINE = [
  'run-execution.ts',
  'run-completion.ts',
  'run-admission.ts',
  'run-session.ts',
  'run-live-state.ts',
  'trace-runtime.ts'
].map((entry) => resolve(__dirname, entry))

const MAIN_ENTRY = resolve(__dirname, '../index.ts')

describe('run pipeline has no Electron runtime dependency', () => {
  for (const entry of PIPELINE) {
    it(`${entry.replace(`${resolve(__dirname)}/`, '')} has no value import of electron`, () => {
      const { files, electron } = electronDependents(entry)
      expect(files).toBeGreaterThan(0)
      expect(electron).toEqual([])
    })
  }

  // The checker must be able to fail: Electron main imports it directly.
  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
