import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

const RECOVERY = resolve(__dirname, '../main/bootstrap/startup-recovery.ts')
const MAIN = resolve(__dirname, '../main/index.ts')

describe('shared startup recovery', () => {
  it('has no Electron value dependency so the daemon can run it before serving', () => {
    const { files, electron } = electronDependents(RECOVERY)
    expect(files).toBeGreaterThan(5)
    expect(electron).toEqual([])
  })

  it('checker still detects Electron main', () => {
    expect(electronDependents(MAIN).electron.some((entry) => entry.startsWith(MAIN))).toBe(true)
  })
})
