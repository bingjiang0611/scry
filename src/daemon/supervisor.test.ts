import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLaunchEnvironment, launchDaemonOnce, superviseDaemon, writeSupervisorTemplates } from './supervisor'

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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

  it('does not retry a deterministic remote lease failure', async () => {
    const directory = root()
    let launches = 0
    const result = await superviseDaemon({
      directory,
      launch: async () => { launches += 1; return { code: 4, signal: null, reason: 'remote_lease_owner_alive', runtimeMs: 5 } }
    })
    expect(launches).toBe(1)
    expect(result).toEqual({ status: 'failed', attempts: 1, reason: 'remote_lease_owner_alive' })
    const record = JSON.parse(readFileSync(join(directory, 'supervisor-failure.json'), 'utf8'))
    expect(record.reason).toBe('remote_lease_owner_alive')
    expect(record.lastExit).toEqual({ code: 4, signal: null })
  })

  it('captures a bounded remote lease reason from stderr without the body', async () => {
    const directory = root()
    const entry = join(directory, 'fail-lease.mjs')
    writeFileSync(entry, "process.stderr.write('remote_lease_identity_unverifiable: /Users/me/secret body\\n'); process.exit(4)\n")
    const result = await launchDaemonOnce({ executable: process.execPath, daemonEntry: entry, env: process.env })
    expect(result).toMatchObject({ code: 4, signal: null, reason: 'remote_lease_identity_unverifiable' })
    expect(JSON.stringify(result)).not.toContain('secret body')
    expect(JSON.stringify(result)).not.toContain('/Users/me')
  })

  it('captures only a bounded daemon error code from stderr', async () => {
    const directory = root()
    const entry = join(directory, 'fail.mjs')
    writeFileSync(entry, "process.stderr.write('daemon_paths_missing: secret body\\n'); process.exit(2)\n")
    const result = await launchDaemonOnce({ executable: process.execPath, daemonEntry: entry, env: process.env })
    expect(result).toMatchObject({ code: 2, signal: null, reason: 'daemon_paths_missing' })
    expect(JSON.stringify(result)).not.toContain('secret body')
  })

  // A service manager stops the supervisor, not the daemon. The supervisor must hand one
  // SIGTERM to the daemon and stay until the daemon's cleanup has run: once it exits, the
  // service manager kills whatever is left and the cleanup is cut short.
  it('on stop forwards one SIGTERM and resolves only after the daemon has exited', async () => {
    const directory = root()
    const entry = join(directory, 'slow-stop.mjs')
    const marker = join(directory, 'cleanup-done')
    const signals = join(directory, 'signals')
    const ready = join(directory, 'ready')
    writeFileSync(entry, [
      "import { appendFileSync, writeFileSync } from 'node:fs'",
      "process.on('SIGTERM', () => {",
      `  appendFileSync(${JSON.stringify(signals)}, 'TERM\\n')`,
      `  setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'done'); process.exit(0) }, 400)`,
      '})',
      `writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    const abort = new AbortController()
    const launched = launchDaemonOnce({ executable: process.execPath, daemonEntry: entry, env: process.env, signal: abort.signal })
    await waitFor(() => existsSync(ready))
    abort.abort()
    abort.abort()
    const result = await launched
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(signals, 'utf8')).toBe('TERM\n')
    expect(result).toMatchObject({ code: 0, signal: null, stopRequested: true })
  })

  it('reports daemon_stop_timeout when the daemon outlives the stop bound, without a second signal', async () => {
    const directory = root()
    const entry = join(directory, 'stuck-stop.mjs')
    const signals = join(directory, 'signals')
    const ready = join(directory, 'ready')
    // Ignores SIGTERM and leaves by itself well after the bound, so the test leaves no process.
    writeFileSync(entry, [
      "import { appendFileSync, writeFileSync } from 'node:fs'",
      `process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(signals)}, 'TERM\\n') })`,
      `writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      'setTimeout(() => process.exit(0), 2000)'
    ].join('\n'))
    const abort = new AbortController()
    const launched = launchDaemonOnce({ executable: process.execPath, daemonEntry: entry, env: process.env, signal: abort.signal, stopTimeoutMs: 300 })
    await waitFor(() => existsSync(ready))
    abort.abort()
    const result = await launched
    expect(result).toMatchObject({ code: null, signal: null, reason: 'daemon_stop_timeout', stopRequested: true })
    expect(readFileSync(signals, 'utf8')).toBe('TERM\n')
  })

  it('stops without restarting once a stop was requested, whatever the exit code', async () => {
    const abort = new AbortController()
    let launches = 0
    const result = await superviseDaemon({
      directory: root(),
      stopSignal: abort.signal,
      launch: async () => { launches += 1; abort.abort(); return { code: 1, signal: null, stopRequested: true } },
      sleep: async () => undefined
    })
    expect(result).toEqual({ status: 'stopped', attempts: 1 })
    expect(launches).toBe(1)
  })

  it('reports a stop timeout without writing a launch failure record', async () => {
    const directory = root()
    const result = await superviseDaemon({
      directory,
      launch: async () => ({ code: null, signal: null, reason: 'daemon_stop_timeout', stopRequested: true })
    })
    expect(result).toEqual({ status: 'stop-timeout', attempts: 1 })
    expect(existsSync(join(directory, 'supervisor-failure.json'))).toBe(false)
  })

  it('does not launch again when the stop arrives during the restart delay', async () => {
    const abort = new AbortController()
    let launches = 0
    const result = await superviseDaemon({
      directory: root(),
      stopSignal: abort.signal,
      launch: async () => { launches += 1; return { code: 1, signal: null } },
      sleep: async () => { abort.abort() }
    })
    expect(result).toEqual({ status: 'stopped', attempts: 1 })
    expect(launches).toBe(1)
  })

  it('sets launchedBy only from its explicit argument, never from the source environment', () => {
    const base = { stateDirectory: '/s', userDataDir: '/u', appPath: '/a', resourcesPath: '/r', appVersion: '1', isPackaged: true, startedBy: 'x' }
    const source = { HOME: '/h', SCRY_DAEMON_LAUNCHED_BY: 'service' }
    expect('SCRY_DAEMON_LAUNCHED_BY' in daemonLaunchEnvironment({ ...base, source })).toBe(false)
    expect(daemonLaunchEnvironment({ ...base, source, launchedBy: 'app' }).SCRY_DAEMON_LAUNCHED_BY).toBe('app')
  })

  it('forwards only allowlisted variables: SCRY_REMOTE_RELAY_SSH has no reader and is dropped', () => {
    const base = { stateDirectory: '/s', userDataDir: '/u', appPath: '/a', resourcesPath: '/r', appVersion: '1', isPackaged: true, startedBy: 'x' }
    const env = daemonLaunchEnvironment({ ...base, source: { HOME: '/h', SCRY_REMOTE_RELAY_ENABLED: '0', SCRY_REMOTE_RELAY_SSH: 'host', NODE_OPTIONS: '--require /x' } })
    expect(env.HOME).toBe('/h')
    expect(env.SCRY_REMOTE_RELAY_ENABLED).toBe('0')
    expect('SCRY_REMOTE_RELAY_SSH' in env).toBe(false)
    expect('NODE_OPTIONS' in env).toBe(false)
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
