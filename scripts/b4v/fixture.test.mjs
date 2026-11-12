// The fixture's daemon handling against real processes: a stand-in supervisor and daemon
// (plain Node, same file names and environment as the product's) prove that the scripts
// find this fixture's tree by its state directory, stop it through verified identities,
// report leftovers, and leave an unrelated process alone even when a lock names its pid.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectLiveIsolation, createFixture, daemonHolder, disposeFixture, fixtureDaemonProcesses, fixtureLeftovers, stopFixtureDaemon
} from './fixture.mjs'
import { readIdentity, signalVerified } from './process-identity.mjs'

const SUPERVISOR = `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const child = spawn(process.execPath, [join(__dirname, 'daemon.js')], { env: process.env, stdio: 'ignore' })
writeFileSync(join(process.env.SCRY_DAEMON_STATE_DIR, 'child.pid'), String(child.pid))
process.on('SIGTERM', () => { child.kill('SIGTERM'); child.once('exit', () => process.exit(0)) })
setInterval(() => {}, 1000)
`
const DAEMON = `process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

const until = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timeout')
}

describe('b4v fixture against a stand-in daemon tree', () => {
  const fixtures = []
  const spawned = []
  const grandchildren = []
  afterEach(() => {
    for (const child of spawned.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // The stand-in daemon is the supervisor's child, not ours: stop it by verified identity.
    for (const identity of grandchildren.splice(0)) signalVerified(identity, 'SIGKILL')
    for (const fixture of fixtures.splice(0)) disposeFixture(fixture, { keep: false })
  })

  async function standIn() {
    const fixture = createFixture('unit')
    fixtures.push(fixture)
    const bin = join(fixture.tempRoot, 'bin')
    mkdirSync(bin)
    mkdirSync(fixture.daemonState, { recursive: true })
    writeFileSync(join(bin, 'daemon-supervisor.js'), SUPERVISOR)
    writeFileSync(join(bin, 'daemon.js'), DAEMON)
    const supervisor = spawn(process.execPath, [join(bin, 'daemon-supervisor.js')], {
      env: { PATH: process.env.PATH, SCRY_DAEMON_STATE_DIR: fixture.daemonState, SCRY_DAEMON_USER_DATA_DIR: fixture.userDataDir },
      stdio: 'ignore', detached: true
    })
    spawned.push(supervisor)
    const daemonPid = Number(await until(() => existsSync(join(fixture.daemonState, 'child.pid')) && readFileSync(join(fixture.daemonState, 'child.pid'), 'utf8')))
    const daemon = await until(() => readIdentity(daemonPid))
    grandchildren.push(daemon)
    const lock = { pid: daemon.pid, startedAt: daemon.startedAt, identityKey: daemon.identityKey, startedBy: `supervisor:${supervisor.pid}` }
    writeFileSync(join(fixture.daemonState, 'daemon.lock'), JSON.stringify(lock))
    writeFileSync(join(fixture.userDataDir, 'scry-userdata.lock'), JSON.stringify({ ...lock, role: 'daemon' }))
    writeFileSync(join(fixture.userDataDir, 'scry.db'), '')
    return { fixture, supervisor, daemon }
  }

  it('creates an isolated fixture under /tmp', () => {
    const fixture = createFixture('unit')
    fixtures.push(fixture)
    expect(fixture.staticIsolation.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(fixture.userDataDir, 'projects.json'), 'utf8'))[0].cwd).toBe(fixture.workspace)
    expect(() => createFixture('Not Valid')).toThrow(/kebab-case/)
  })

  it('finds, verifies and stops this fixture\'s tree, then reports what it left', async () => {
    const { fixture, supervisor, daemon } = await standIn()
    expect(daemonHolder(fixture).verdict).toBe('verified')
    const processes = fixtureDaemonProcesses(fixture)
    expect(processes.status).toBe('available')
    expect(processes.daemon.map((row) => row.pid)).toEqual([daemon.pid])
    expect(processes.supervisor.map((row) => row.pid)).toEqual([supervisor.pid])
    expect(collectLiveIsolation(fixture, { mode: 'daemon' }).ok).toBe(true)

    const stopped = await stopFixtureDaemon(fixture, { timeoutMs: 10_000 })
    expect(stopped.remaining).toEqual([])
    expect(stopped.signals.filter((signal) => signal.signal === 'SIGTERM').every((signal) => signal.signalled || signal.verdict === 'gone')).toBe(true)
    const leftovers = fixtureLeftovers(fixture)
    expect(leftovers.processes).toEqual({ status: 'available', live: [] })
    // The stand-in never removes its lock files: the report must say so.
    expect(leftovers.files).toEqual(expect.arrayContaining([join(fixture.daemonState, 'daemon.lock'), join(fixture.userDataDir, 'scry-userdata.lock')]))
  }, 30_000)

  it('leaves alone a process a lock names but whose identity does not match', async () => {
    const fixture = createFixture('unit')
    fixtures.push(fixture)
    mkdirSync(fixture.daemonState, { recursive: true })
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    spawned.push(decoy)
    const identity = await until(() => readIdentity(decoy.pid))
    writeFileSync(join(fixture.daemonState, 'daemon.lock'), JSON.stringify({ pid: decoy.pid, identityKey: `${identity.identityKey}-reused`, startedBy: 'supervisor:1' }))
    expect(daemonHolder(fixture).verdict).toBe('pid-reused')
    const stopped = await stopFixtureDaemon(fixture, { timeoutMs: 1_000 })
    expect(stopped.signals).toEqual([])
    expect(readIdentity(decoy.pid)?.identityKey).toBe(identity.identityKey)
    expect(collectLiveIsolation(fixture, { mode: 'daemon' }).ok).toBe(false)
  }, 30_000)
})
