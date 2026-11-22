import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

const ENTRY = resolve(__dirname, 'host-runtime.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/bootstrap/remote-host.ts')
describe('host runtime has no Electron dependency', () => {
  it('never needs the electron runtime through a value import', () => {
    const { files, electron } = electronDependents(ENTRY)
    expect(files).toBeGreaterThan(20)
    expect(electron).toEqual([])
  })

  it('detects Electron in a module that really imports it', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
