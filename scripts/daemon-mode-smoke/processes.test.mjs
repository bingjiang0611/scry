import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLaunch } from '../b4v/process-identity.mjs'
import { checkDaemonLaunch, daemonProcessEvidence } from './processes.mjs'
import { recordingFiles, runOutputFiles } from './workers.mjs'

const resources = '/opt/Scry/resources'
const packaged = {
  ok: true, packaged: true, executable: '/opt/Scry/scry', resources,
  appArchive: `${resources}/app.asar`, entryDirectory: `${resources}/app.asar/out/main`
}
const state = '/tmp/fixture/userData/daemon'
const identity = (path) => path
const env = (overrides = {}) => ({ status: 'available', env: {
  ELECTRON_RUN_AS_NODE: '1', SCRY_DAEMON_PACKAGED: '1', SCRY_DAEMON_APP_PATH: `${resources}/app.asar`,
  SCRY_DAEMON_RESOURCES_PATH: resources, SCRY_DAEMON_STATE_DIR: state, ...overrides
} })
const linuxLaunch = (executable, entry) => ({ status: 'available', executable, argv: [executable, entry], command: `${executable} ${entry}` })
const check = (launch, environment = env(), role = 'daemon') =>
  checkDaemonLaunch({ role, launch, env: environment, target: packaged, stateDirectory: state, realpath: identity })

describe('checkDaemonLaunch: the daemon must run the packaged binary and archive', () => {
  it('accepts the packaged executable with the archive entry and the packaged environment', () => {
    expect(check(linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon.js`))).toMatchObject({ ok: true, role: 'daemon' })
    expect(check(linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon-supervisor.js`), env(), 'supervisor')).toMatchObject({ ok: true })
    // macOS: no exact argv, the whole command is compared.
    const mac = { status: 'available', executable: '/opt/Scry/scry', command: `/opt/Scry/scry ${resources}/app.asar/out/main/daemon.js` }
    expect(check(mac)).toMatchObject({ ok: true })
    expect(check({ ...mac, command: `${mac.command} --extra` })).toMatchObject({ ok: false, failures: ['entry_mismatch'] })
  })

  it('names each way a dev or foreign process differs', () => {
    expect(check(linuxLaunch('/repo/node_modules/electron/dist/electron', `${resources}/app.asar/out/main/daemon.js`)).failures).toEqual(['executable_mismatch'])
    expect(check(linuxLaunch('/opt/Scry/scry', '/repo/out/main/daemon.js')).failures).toEqual(['entry_mismatch'])
    expect(check(linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon.js`), env({ SCRY_DAEMON_PACKAGED: '0', SCRY_DAEMON_APP_PATH: '/repo' })).failures)
      .toEqual(['packaged_flag_mismatch', 'app_path_mismatch'])
    expect(check(linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon.js`), env({ ELECTRON_RUN_AS_NODE: undefined, SCRY_DAEMON_RESOURCES_PATH: '/elsewhere', SCRY_DAEMON_STATE_DIR: '/other' })).failures)
      .toEqual(['not_run_as_node', 'resources_mismatch', 'state_directory_mismatch'])
  })

  it('treats unreadable evidence as a failure, never a pass', () => {
    expect(check({ status: 'unavailable', reason: 'EACCES' })).toEqual({ ok: false, role: 'daemon', failures: ['launch_unavailable:EACCES'] })
    expect(check(linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon.js`), { status: 'unavailable', reason: 'EPERM' }).failures)
      .toEqual(['environment_unavailable:EPERM'])
  })
})

describe('daemonProcessEvidence finds the daemon only through its verified lock', () => {
  const lock = { pid: 20, identityKey: '20:k', startedBy: 'supervisor:10' }
  const rows = { 20: { pid: 20, ppid: 10, status: 'S', identityKey: '20:k' }, 10: { pid: 10, ppid: 1, status: 'S', identityKey: '10:k' } }
  const probes = (overrides = {}) => ({
    readLockRecord: () => lock, readIdentity: (pid) => rows[pid], realpath: identity,
    readLaunch: (pid) => linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/${pid === 20 ? 'daemon.js' : 'daemon-supervisor.js'}`),
    readProcessEnv: () => env(), ...overrides
  })

  it('reports both processes and the resources the daemon was given', () => {
    const evidence = daemonProcessEvidence(state, packaged, probes())
    expect(evidence).toMatchObject({ ok: true, daemon: { pid: 20, ok: true }, supervisor: { pid: 10, ok: true }, daemonResources: resources })
  })

  it('refuses a missing lock, a reused pid, and a supervisor that is not the parent', () => {
    expect(daemonProcessEvidence(state, packaged, probes({ readLockRecord: () => null }))).toMatchObject({ ok: false, reason: 'daemon_lock_missing' })
    expect(daemonProcessEvidence(state, packaged, probes({ readIdentity: (pid) => pid === 20 ? { ...rows[20], identityKey: '20:other' } : rows[pid] })))
      .toMatchObject({ ok: false, reason: 'daemon_holder_pid-reused' })
    expect(daemonProcessEvidence(state, packaged, probes({ readIdentity: (pid) => pid === 20 ? { ...rows[20], ppid: 99 } : rows[pid] })))
      .toMatchObject({ ok: false, reason: 'supervisor_not_daemon_parent' })
    expect(daemonProcessEvidence(state, packaged, probes({ readLockRecord: () => ({ ...lock, startedBy: 'app:5' }) })))
      .toMatchObject({ ok: false, reason: 'daemon_not_started_by_supervisor' })
  })

  it('fails when the supervisor runs a dev Electron', () => {
    const evidence = daemonProcessEvidence(state, packaged, probes({
      readLaunch: (pid) => pid === 20 ? linuxLaunch('/opt/Scry/scry', `${resources}/app.asar/out/main/daemon.js`) : linuxLaunch('/repo/electron', `${resources}/app.asar/out/main/daemon-supervisor.js`)
    }))
    expect(evidence).toMatchObject({ ok: false, daemon: { ok: true }, supervisor: { ok: false, failures: ['executable_mismatch'] } })
  })
})

describe('readLaunch', () => {
  it('reads exact argv and the executable link on Linux, comm and command on macOS', () => {
    const files = { '/proc/7/cmdline': '/opt/Scry/scry\0/opt/Scry/resources/app.asar/out/main/daemon.js\0' }
    expect(readLaunch(7, { platform: 'linux', readFile: (path) => files[path], readLink: () => '/opt/Scry/scry' })).toEqual({
      status: 'available', executable: '/opt/Scry/scry', argv: ['/opt/Scry/scry', '/opt/Scry/resources/app.asar/out/main/daemon.js'],
      command: '/opt/Scry/scry /opt/Scry/resources/app.asar/out/main/daemon.js'
    })
    const ps = (args) => args.includes('comm=') ? '/A/Scry\n' : '/A/Scry /A/app.asar/out/main/daemon.js\n'
    expect(readLaunch(7, { platform: 'darwin', ps })).toEqual({ status: 'available', executable: '/A/Scry', command: '/A/Scry /A/app.asar/out/main/daemon.js' })
    expect(readLaunch(7, { platform: 'linux', readFile: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } })).toEqual({ status: 'unavailable', reason: 'ENOENT' })
    expect(readLaunch(0)).toEqual({ status: 'unavailable', reason: 'invalid_pid' })
  })
})

describe('worker evidence on disk', () => {
  const temps = []
  afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }) })
  const userData = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'scry-worker-evidence-'))); temps.push(path); return path }

  it('needs both recording files, non-empty, for this terminal', () => {
    const root = userData()
    expect(recordingFiles(root, 'terminal-1')).toMatchObject({ ok: false })
    mkdirSync(join(root, 'terminal-recordings'))
    writeFileSync(join(root, 'terminal-recordings', 'terminal-1.json'), '{}')
    expect(recordingFiles(root, 'terminal-1')).toMatchObject({ ok: false, reason: 'recording_files_missing_or_empty' })
    writeFileSync(join(root, 'terminal-recordings', 'terminal-1.bin'), 'x')
    expect(recordingFiles(root, 'terminal-1')).toMatchObject({ ok: true })
    expect(recordingFiles(root, 'terminal-2')).toMatchObject({ ok: false })
  })

  it('links the App run to the ledger run and requires its output text in the worker files', async () => {
    const root = userData()
    expect(runOutputFiles(root, 'remote-run-1')).toMatchObject({ ok: false, reason: 'ledger_run_unlinked' })
    mkdirSync(join(root, 'remote', 'ledger'), { recursive: true })
    const bound = { seq: 1, runId: 'ledger-1', kind: 'run_progress', detail: JSON.stringify({ event: 'bound', scryRunId: 'remote-run-1', ledgerRunId: 'ledger-1' }) }
    writeFileSync(join(root, 'remote', 'ledger', 'session-ledger.log'), `${JSON.stringify(bound)}\n`)
    expect(runOutputFiles(root, 'remote-run-1')).toMatchObject({ ok: false, reason: 'run_output_files_missing_or_empty', runId: 'ledger-1' })
    const { createHash } = await import('node:crypto')
    const key = createHash('sha256').update('ledger-1').digest('hex')
    mkdirSync(join(root, 'remote', 'output'), { recursive: true })
    writeFileSync(join(root, 'remote', 'output', `${key}.idx`), 'i')
    writeFileSync(join(root, 'remote', 'output', `${key}.jsonl`), `${JSON.stringify({ seq: 1, runId: 'ledger-1', kind: 'tool', text: 'x', at: 1 })}\n`)
    expect(runOutputFiles(root, 'remote-run-1')).toMatchObject({ ok: false, reason: 'run_output_text_missing' })
    writeFileSync(join(root, 'remote', 'output', `${key}.jsonl`), `${JSON.stringify({ seq: 1, runId: 'ledger-1', kind: 'output', text: 'hello', at: 1 })}\n`)
    expect(runOutputFiles(root, 'remote-run-1')).toMatchObject({ ok: true, runId: 'ledger-1', outputChars: 5 })
  })
})
