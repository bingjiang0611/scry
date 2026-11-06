import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superviseDaemon, writeSupervisorTemplates } from './supervisor'

const roots: string[] = []
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'scry-supervisor-')); roots.push(value); return value }
afterEach(() => { roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })) })

describe('daemon supervisor', () => {
  it('uses bounded exponential restart and leaves a readable failure record', async () => {
    const directory = root()
    const delays: number[] = []
    let launches = 0
    const result = await superviseDaemon({
      directory,
      maxRestarts: 3,
      baseDelayMs: 100,
      maxDelayMs: 250,
      launch: async () => { launches += 1; return { code: 7, signal: null } },
      sleep: async (ms) => { delays.push(ms) },
      now: () => 1234
    })
    expect(result).toEqual({ status: 'exhausted', attempts: 4 })
    expect(launches).toBe(4)
    expect(delays).toEqual([100, 200, 250])
    expect(JSON.parse(readFileSync(join(directory, 'supervisor-failure.json'), 'utf8'))).toEqual({
      version: 1, failedAt: 1234, attempts: 4, lastExit: { code: 7, signal: null }
    })
  })

  it('does not restart a clean exit or an already-running peer', async () => {
    for (const code of [0, 3]) {
      let launches = 0
      const result = await superviseDaemon({ directory: root(), launch: async () => { launches += 1; return { code, signal: null } } })
      expect(result).toEqual({ status: code === 0 ? 'stopped' : 'already-running', attempts: 1 })
      expect(launches).toBe(1)
    }
  })

  it('generates launchd and systemd user templates without installing them', () => {
    const directory = root()
    const files = writeSupervisorTemplates({ directory, executable: '/Applications/Scry.app/Contents/MacOS/Scry', supervisorEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon-supervisor.js', daemonEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon.js', userDataDir: '/Users/me/Library/Application Support/Scry' })
    expect(readFileSync(files.launchd, 'utf8')).toContain('ELECTRON_RUN_AS_NODE')
    expect(readFileSync(files.systemd, 'utf8')).toContain('Restart=no')
    expect(files.launchd.startsWith(directory)).toBe(true)
    expect(files.systemd.startsWith(directory)).toBe(true)
  })
})
