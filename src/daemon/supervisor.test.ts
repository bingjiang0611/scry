import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLaunchEnvironment, launchDaemonOnce, superviseDaemon } from './supervisor'

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

  it('forwards tunables and drops retired orchestration and relay settings', () => {
    const base = { stateDirectory: '/s', userDataDir: '/u', appPath: '/a', resourcesPath: '/r', appVersion: '1', isPackaged: true, startedBy: 'x' }
    const env = daemonLaunchEnvironment({
      ...base,
      source: {
        HOME: '/h',
        SCRY_REMOTE_RELAY_ENABLED: '0',
        SCRY_ORCHESTRATION: 'shadow',
        SCRY_ORCHESTRATION_FULLFSYNC: '1',
        SCRY_REMOTE_RELAY_SSH: 'host',
        NODE_OPTIONS: '--require /x'
      }
    })
    expect(env.HOME).toBe('/h')
    expect(env.SCRY_REMOTE_RELAY_ENABLED).toBe('0')
    expect('SCRY_ORCHESTRATION' in env).toBe(false)
    expect(env.SCRY_ORCHESTRATION_FULLFSYNC).toBe('1')
    expect('SCRY_REMOTE_RELAY_SSH' in env).toBe(false)
    expect('NODE_OPTIONS' in env).toBe(false)
  })

  it('hands the smoke fixture inputs on only for a test instance that asked for the daemon fixture (S3)', () => {
    const base = { stateDirectory: '/s', userDataDir: '/u', appPath: '/a', resourcesPath: '/r', appVersion: '1', isPackaged: false, startedBy: 'x' }
    const fixture = {
      SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1', SCRY_ELECTRON_SMOKE_SIDE_CHAT: '1', SCRY_ELECTRON_SMOKE_INPUTS: '/t/inputs',
      SCRY_ELECTRON_SMOKE_CALLS: '/t/calls', SCRY_ELECTRON_SMOKE_IDENTITY: 'id', SCRY_ELECTRON_SMOKE_READER: '1', SCRY_ELECTRON_SMOKE_READS: '/t/reads',
      // The concurrent-performance fixture's probe, log, role and built CLI ride the same gate.
      SCRY_CONCURRENT_PROBE: '/t/probe.cjs', SCRY_CONCURRENT_LOG: '/t/probe.jsonl', SCRY_CONCURRENT_ROLE: 'main', SCRY_CLI_PATH: '/t/scry'
    }
    const keys = Object.keys(fixture)
    // A normal launch, or a test instance that did not ask for the daemon fixture: nothing.
    for (const source of [{ ...fixture }, { ...fixture, SCRY_TEST_APP: '1' }, { ...fixture, SCRY_DAEMON_SMOKE_PROVIDER: '1' }]) {
      const env = daemonLaunchEnvironment({ ...base, source })
      for (const key of keys) expect(key in env, key).toBe(false)
    }
    // The App's hop: a test instance with the daemon fixture.
    const supervisorEnv = daemonLaunchEnvironment({ ...base, source: { ...fixture, SCRY_TEST_APP: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1' } })
    for (const key of keys) expect(supervisorEnv[key], key).toBe(fixture[key as keyof typeof fixture])
    expect('SCRY_TEST_APP' in supervisorEnv).toBe(false)
    // The supervisor's hop: its environment came from the first hop, so it passes them on.
    const daemonEnv = daemonLaunchEnvironment({ ...base, source: supervisorEnv, hop: 'supervisor' })
    for (const key of keys) expect(daemonEnv[key], key).toBe(fixture[key as keyof typeof fixture])
  })

  it('does not take a daemon state directory as proof of a fixture hop', () => {
    // Every daemon environment carries SCRY_DAEMON_STATE_DIR; only the marker this
    // function sets on a hop it handed the fixture to lets the next hop pass it on.
    const base = { stateDirectory: '/s', userDataDir: '/u', appPath: '/a', resourcesPath: '/r', appVersion: '1', isPackaged: false, startedBy: 'x' }
    const fixture = { SCRY_ELECTRON_SMOKE_INPUTS: '/t/inputs', SCRY_ELECTRON_SMOKE_CALLS: '/t/calls', SCRY_ELECTRON_SMOKE_SIDE_CHAT: '1' }
    const env = daemonLaunchEnvironment({ ...base, source: { ...fixture, SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_STATE_DIR: '/elsewhere' } })
    for (const key of Object.keys(fixture)) expect(key in env, key).toBe(false)
    expect('SCRY_DAEMON_SMOKE_FIXTURE_HOP' in env).toBe(false)
    // A normal launch's own environment is not a fixture hop either.
    const normal = daemonLaunchEnvironment({ ...base, source: { SCRY_DAEMON_SMOKE_PROVIDER: '1' } })
    expect('SCRY_DAEMON_SMOKE_FIXTURE_HOP' in normal).toBe(false)
    const next = daemonLaunchEnvironment({ ...base, source: { ...normal, ...fixture }, hop: 'supervisor' })
    for (const key of Object.keys(fixture)) expect(key in next, key).toBe(false)
    // The marker is the supervisor hop's proof only: at the App's hop it proves nothing.
    const spoofed = daemonLaunchEnvironment({ ...base, source: { ...fixture, SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_SMOKE_FIXTURE_HOP: '1' } })
    for (const key of Object.keys(fixture)) expect(key in spoofed, key).toBe(false)
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
