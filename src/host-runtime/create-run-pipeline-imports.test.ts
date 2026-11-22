import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { electronDependents } from './value-import-graph'

const ENTRY = resolve(__dirname, 'create-run-pipeline.ts')
const MAIN_ENTRY = resolve(__dirname, '../main/index.ts')

describe('run pipeline assembly has no Electron dependency', () => {
  it('exists and never needs the electron runtime through a value import', () => {
    expect(existsSync(ENTRY)).toBe(true)
    const { files, electron } = electronDependents(ENTRY)
    expect(files).toBeGreaterThan(5)
    expect(electron).toEqual([])
  })

  it('detects Electron in Electron main', () => {
    expect(electronDependents(MAIN_ENTRY).electron.some((entry) => entry.startsWith(MAIN_ENTRY))).toBe(true)
  })
})
