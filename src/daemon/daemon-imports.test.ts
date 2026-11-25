import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from '../host-runtime/value-import-graph'

const ENTRY = resolve(__dirname, 'main.ts')
const SUPERVISOR_ENTRY = resolve(__dirname, 'supervisor-main.ts')
const LOGIN_START_ENTRY = resolve(__dirname, 'login-start/manager.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')
const HISTORY = resolve(__dirname, '../main/bootstrap/remote-history.ts')

describe('daemon entry has no Electron dependency', () => {
  it('never needs the electron runtime through a value import', () => {
    const { files, electron } = electronDependents(ENTRY)
    expect(files).toBeGreaterThan(2)
    expect(electron).toEqual([])
  })

  it('keeps the supervisor on the same plain-Node boundary', () => {
    const { files, electron } = electronDependents(SUPERVISOR_ENTRY)
    expect(files).toBeGreaterThan(1)
    expect(electron).toEqual([])
  })

  it('keeps the login-start module free of Electron (shared by main and scry-host)', () => {
    const { files, electron } = electronDependents(LOGIN_START_ENTRY)
    expect(files).toBeGreaterThan(1)
    expect(electron).toEqual([])
  })

  it('reads history through an injected userData directory', () => {
    const { files, electron } = electronDependents(HISTORY)
    expect(files).toBeGreaterThan(1)
    expect(electron).toEqual([])
  })

  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
