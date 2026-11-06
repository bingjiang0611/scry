import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDaemonOnce, superviseDaemon, writeSupervisorTemplates } from './supervisor'

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
    const files = writeSupervisorTemplates({
      directory,
      executable: '/Applications/Scry.app/Contents/MacOS/Scry',
      supervisorEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon-supervisor.js',
      daemonEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon.js',
      userDataDir: '/Users/me/Library/Application Support/Scry',
      appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Scry.app/Contents/Resources',
      appVersion: '9.8.7',
      isPackaged: true
    } as Parameters<typeof writeSupervisorTemplates>[0])
    const launchd = readFileSync(files.launchd, 'utf8')
    const systemd = readFileSync(files.systemd, 'utf8')
    for (const key of ['SCRY_DAEMON_APP_PATH', 'SCRY_DAEMON_RESOURCES_PATH', 'SCRY_DAEMON_APP_VERSION', 'SCRY_DAEMON_PACKAGED']) {
      expect(launchd).toContain(key)
      expect(systemd).toContain(key)
    }
    expect(launchd).toContain('ELECTRON_RUN_AS_NODE')
    expect(systemd).toContain('Restart=no')
    expect(files.launchd.startsWith(directory)).toBe(true)
    expect(files.systemd.startsWith(directory)).toBe(true)
  })

  it('does not retry a known configuration failure and records only its code', async () => {
    const directory = root()
    let launches = 0
    const result = await superviseDaemon({
      directory,
      launch: async () => { launches += 1; return { code: 2, signal: null, reason: 'daemon_paths_missing', runtimeMs: 5 } as never }
    })
    expect(launches).toBe(1)
    expect(result).toEqual({ status: 'failed', attempts: 1, reason: 'daemon_paths_missing' })
    expect(JSON.parse(readFileSync(join(directory, 'supervisor-failure.json'), 'utf8')).reason).toBe('daemon_paths_missing')
  })

  it('captures only a bounded daemon error code from stderr', async () => {
    const directory = root()
    const entry = join(directory, 'fail.mjs')
    writeFileSync(entry, "process.stderr.write('daemon_paths_missing: secret body\\n'); process.exit(2)\n")
    const result = await launchDaemonOnce({ executable: process.execPath, daemonEntry: entry, env: process.env })
    expect(result).toMatchObject({ code: 2, signal: null, reason: 'daemon_paths_missing' })
    expect(JSON.stringify(result)).not.toContain('secret body')
  })

  it('resets its restart budget after a stable run', async () => {
    const directory = root()
    const exits = [
      { code: 1, signal: null, runtimeMs: 1 },
      { code: 1, signal: null, runtimeMs: 60_001 },
      { code: 1, signal: null, runtimeMs: 1 },
      { code: 0, signal: null, runtimeMs: 1 }
    ]
    const result = await superviseDaemon({
      directory,
      maxRestarts: 2,
      stableRunMs: 60_000,
      launch: async () => exits.shift()! as never,
      sleep: async () => undefined
    } as Parameters<typeof superviseDaemon>[0])
    expect(result).toEqual({ status: 'stopped', attempts: 4 })
  })
})
