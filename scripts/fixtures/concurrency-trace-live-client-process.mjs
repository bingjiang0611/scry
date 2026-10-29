// Parent side of the private client process (R6.3).
//
// Spawns the bundled fixture main (`concurrency-trace-live-electron.ts` compiled by
// buildLiveFixture), speaks only the fixed command enum over Node IPC, and reuses the C1
// snapshot bootstrap request/reply so CPU/memory samples come from the same process boundary
// the rest of the harness uses. Spawn and readiness are separate: the caller owns the child
// from `spawn()`, and a failed `ready()` still leaves an owner that stops it.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLIENT_FAULT_TYPE,
  CLIENT_MESSAGE_TYPE,
  CLIENT_REPLY_TYPE
} from './concurrency-trace-live-protocol.mjs'
import { ownedChild } from './concurrency-trace-live-lifecycle.mjs'
import {
  createOutputCapture,
  openSnapshotChannel,
  watchChildClose
} from '../session-concurrency-electron.mjs'

/** Explicit allowlist: the client sees its temporary home and the fixture paths only. */
export function clientEnv({ home, tmp, indexPath, preloadPath, windowOptions, hiddenWindowsPath, userData, stateRoot }) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    ELECTRON_ENABLE_LOGGING: '1',
    LIVE_INDEX: indexPath,
    LIVE_PRELOAD: preloadPath,
    // The window options stay owned by the build helper; the client validates them
    // instead of restating them.
    LIVE_WINDOW_OPTIONS: windowOptions,
    LIVE_HIDDEN_WINDOWS: hiddenWindowsPath,
    LIVE_USER_DATA: userData,
    LIVE_STATE: stateRoot
  }
}

const describe = (error) => (error instanceof Error ? error.message : String(error))

export function createClientProcess({ electron, mainEntry, temp, indexPath, preloadPath, windowOptions, hiddenWindowsPath, log, deadlines }) {
  const userData = join(temp, 'client-userData')
  const stateRoot = join(temp, 'client-state')
  const home = join(temp, 'client-home')
  const tmp = join(temp, 'client-tmp')
  let child = null
  let lifecycle = null
  let capture = null
  let faults = []
  let nextId = 1
  let status = { phase: 'created' }

  function request(command, payload = {}, { timeoutMs = 30_000 } = {}) {
    if (!child) return Promise.reject(new Error(`client: ${command} was requested before the process was spawned`))
    if (typeof child.send !== 'function' || child.connected === false) return Promise.reject(new Error(`client: IPC channel is not connected (${command})`))
    const requestId = `live-${nextId++}`
    return new Promise((resolve, reject) => {
      const pendingRequests = status.pending
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error(`client: no reply for ${command} (${requestId}) within ${timeoutMs} ms`))
      }, timeoutMs)
      pendingRequests.set(requestId, { resolve, reject, timer })
      child.send({ type: CLIENT_MESSAGE_TYPE, requestId, command, payload })
    })
  }

  function spawnChild() {
    for (const dir of [userData, stateRoot, home, tmp]) mkdirSync(dir, { recursive: true })
    capture = createOutputCapture({ onLine: (line) => log?.('client', line) })
    child = spawn(electron, [mainEntry, `--user-data-dir=${userData}`, '--disable-gpu',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
      env: clientEnv({ home, tmp, indexPath, preloadPath, windowOptions, hiddenWindowsPath, userData, stateRoot }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    status = { phase: 'spawned', pid: child.pid, userData, stateRoot, pending: new Map() }
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      if (message.type === CLIENT_FAULT_TYPE) {
        const fault = { phase: message.phase ?? null, error: String(message.error ?? 'unknown') }
        faults.push(fault)
        lifecycle?.fault(fault.phase ?? 'client', fault.error)
        return
      }
      if (message.type !== CLIENT_REPLY_TYPE) return
      const entry = status.pending.get(message.requestId)
      if (!entry) return
      status.pending.delete(message.requestId)
      clearTimeout(entry.timer)
      if (message.ok === true) entry.resolve(message.value)
      else entry.reject(new Error(`${message.phase ?? 'client'}: ${String(message.error ?? 'unknown error')}`))
    })
    // Ownership exists as soon as the child does; readiness is a later, separate step.
    lifecycle = ownedChild({
      name: 'client',
      child,
      childClose: watchChildClose(child),
      snapshots: openSnapshotChannel(child),
      requestClose: () => request('close', {}, { timeoutMs: deadlines.stopMs })
    })
    child.stdout.on('data', capture.stdout)
    child.stderr.on('data', capture.stderr)
    child.once('exit', (code, signal) => log?.('client', `electron exited code=${code} signal=${signal}`))
    return { pid: child.pid, userData, stateRoot }
  }

  return {
    get lifecycle() { return lifecycle },
    get record() { return lifecycle?.record ?? null },
    get child() { return child },
    get userData() { return userData },
    get stateRoot() { return stateRoot },
    get faults() { return faults },
    spawn: spawnChild,
    ready: async () => {
      if (!lifecycle) throw new Error('client was not spawned')
      return await lifecycle.ready(async () => {
        const started = await request('status', {}, { timeoutMs: deadlines.hostStartupMs })
        if (!started || typeof started !== 'object') throw new Error('client: status returned no object')
        if (started.userData !== userData) throw new Error(`client: userData ${JSON.stringify(started.userData)} is not the temporary directory ${JSON.stringify(userData)}`)
        if (started.stateRoot !== stateRoot) throw new Error(`client: state root ${JSON.stringify(started.stateRoot)} is not the temporary directory ${JSON.stringify(stateRoot)}`)
        return started
      })
    },
    request,
    pair: (payload) => request('pair', payload, { timeoutMs: deadlines.pairingMs }),
    finish: (peerId) => request('finish', { peerId }, { timeoutMs: deadlines.pairingMs }),
    openWindow: (peerId) => request('window', { peerId }, { timeoutMs: deadlines.windowLoadMs }),
    driver: (peerId, method, args = [], { injectFailure = false, timeoutMs = deadlines.roundMs } = {}) =>
      request('driver', { peerId, method, args, injectFailure }, { timeoutMs }),
    counters: (peerId) => request('counters', { peerId }, { timeoutMs: deadlines.roundMs }),
    abandon: (peerId) => request('abandon', { peerId }, { timeoutMs: deadlines.stopMs }),
    status: () => request('status', {}, { timeoutMs: deadlines.roundMs }),
    /**
     * Boundary sample from this process tree. The renderer side is `unavailable` on purpose:
     * this process is driven over IPC without CDP, and each peer renderer's CPU is read from
     * its own pid inside `main.snapshot.metrics` instead of a different measurement subject.
     */
    sample: async (label) => ({
      label,
      takenAtEpochMs: Date.now(),
      main: await lifecycle.snapshots.take(label),
      renderer: { status: 'unavailable', reason: 'client process has no CDP session; renderer CPU is read per pid from app.getAppMetrics' }
    }),
    shutdown: async (reason = 'launcher') => {
      const record = lifecycle ? await lifecycle.shutdown(reason) : null
      const logState = capture ? { text: capture.finish(), truncated: capture.truncated() } : null
      return { record, log: logState, faults }
    },
    describe: () => ({ ...status, pending: status.pending?.size ?? 0 })
  }
}

export { describe }
