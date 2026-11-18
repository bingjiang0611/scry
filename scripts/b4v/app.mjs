// Drives one real App instance for a B4-V scenario: launch on a fixture, reach the
// renderer over CDP, call the shipped preload API, and end the instance the way a user
// would (graceful quit) or the way a crash would (SIGKILL). Ending an App never touches
// the fixture's daemon tree: the supervisor and the daemon are detached on purpose and
// must outlive the window.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { connectCdp, createEvaluate, freePort, launch, waitForTarget } from '../desktop-remote-host-smoke/harness.mjs'
import { appOwnedProcesses } from './fixture.mjs'
import { signalVerified, waitGone } from './process-identity.mjs'

export function electronExecutable(root, platform = process.platform) {
  return platform === 'darwin'
    ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(root, 'node_modules/electron/dist/electron')
}

/**
 * The only difference between a scenario and its control. Off is spelled out ('0'), so
 * a shell that exported SCRY_HOST_DAEMON=1 cannot turn the control into daemon mode.
 * SCRY_REMOTE_HOST=0: an App that is itself the remote lease owner makes the daemon
 * refuse to start (remote_lease_owner_alive), which is correct and not under test here.
 */
export function modeEnv(mode, extra = {}) {
  const base = mode === 'daemon'
    ? { SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1', SCRY_REMOTE_HOST: '0' }
    : mode === 'switch-off' ? { SCRY_HOST_DAEMON: '0', SCRY_REMOTE_HOST: '0' } : null
  if (!base) throw new Error(`unknown mode: ${mode}`)
  return { ...base, ...extra }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Evaluate without throwing: a refused call is an observation, not a script error. */
export async function attempt(app, expression) {
  try {
    return { ok: true, value: await app.evaluate(expression) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Bounded polling of a renderer expression; the last value and error are the evidence. */
export async function until(app, expression, predicate, timeoutMs, intervalMs = 100) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await attempt(app, expression)
    if (last.ok && predicate(last.value)) return { ok: true, value: last.value, elapsedMs: Date.now() - started }
    if (app.exited) break
    await sleep(intervalMs)
  }
  return { ok: false, value: last?.value, error: last?.error ?? (app.exited ? 'app_exited' : 'timeout'), elapsedMs: Date.now() - started }
}

export const READY_EXPRESSION = 'window.scry.activeRuns().then(() => true, (error) => String(error && error.message || error))'

export async function openApp({ root, fixture, mode, label, env = {}, waitReady = true, readyTimeoutMs = 120_000 }) {
  const port = await freePort()
  const logPath = join(fixture.logs, `${label}.log`)
  const stream = createWriteStream(logPath, { flags: 'a' })
  const spawnedAt = Date.now()
  const child = launch({
    spawn, executable: electronExecutable(root), devApp: true, root, port,
    userDataDir: fixture.userDataDir, home: fixture.home,
    appendLog: (chunk) => stream.write(chunk), env: modeEnv(mode, env)
  })
  const app = { child, pid: child.pid, port, logPath, mode, label, spawnedAt, exited: null, evaluate: null, cdp: null }
  app.exit = new Promise((resolve) => child.once('exit', (code, signal) => {
    app.exited = { code, signal, at: Date.now() }
    stream.end()
    resolve(app.exited)
  }))
  fixture.apps = [...(fixture.apps ?? []), app]
  const target = await waitForTarget(port, 60_000)
  app.targetAt = Date.now()
  app.cdp = connectCdp(target.webSocketDebuggerUrl)
  app.evaluate = createEvaluate(app.cdp)
  const preload = await until(app, 'Boolean(window.scry && window.scry.start)', (value) => value === true, 30_000)
  if (!preload.ok) throw new Error(`preload not ready: ${preload.error}`)
  app.preloadAt = Date.now()
  if (waitReady) {
    // The first call may arrive while the daemon is still starting; the App reports that
    // and asks again (the lazy surface's unavailable rule), so waiting is the user path.
    app.ready = await until(app, READY_EXPRESSION, (value) => value === true, readyTimeoutMs)
    app.readyAt = app.ready.ok ? Date.now() : null
  }
  return app
}

async function settleWithin(promise, timeoutMs) {
  let timer
  const result = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })])
  clearTimeout(timer)
  return result
}

/**
 * Graceful quit: SIGTERM to the App main, which Electron turns into app.quit() (the
 * same before-quit cleanup as Cmd+Q). The App's own children (renderer, GPU, utility)
 * must go with it; the daemon tree is excluded from that set by construction.
 */
export async function quitApp(app, fixture, { timeoutMs = 20_000 } = {}) {
  if (app.exited) return { graceful: null, alreadyExited: app.exited }
  const owned = appOwnedProcesses(app.pid, fixture)
  try { app.cdp?.close() } catch { /* a dead socket is fine */ }
  const quitAt = Date.now()
  app.child.kill('SIGTERM')
  const exited = await settleWithin(app.exit, timeoutMs)
  const children = owned.filter((row) => row.pid !== app.pid)
  let remaining = await waitGone(children, 5_000)
  const result = { graceful: Boolean(exited), quitAt, exitedAt: exited?.at ?? null, code: exited?.code ?? null,
    signal: exited?.signal ?? null, quitMs: exited ? exited.at - quitAt : null, ownedChildren: children.length }
  if (!exited || remaining.length > 0) {
    result.forced = owned.map((row) => ({ pid: row.pid, ...signalVerified(row, 'SIGKILL') }))
    await settleWithin(app.exit, 5_000)
    remaining = await waitGone(owned, 5_000)
  }
  result.remaining = remaining.map(({ pid, command }) => ({ pid, command: command.slice(0, 200) }))
  return result
}

/** Crash: SIGKILL the App main, then reap its own children (never the daemon tree). */
export async function crashApp(app, fixture) {
  if (app.exited) return { alreadyExited: app.exited }
  const owned = appOwnedProcesses(app.pid, fixture)
  try { app.cdp?.close() } catch { /* a dead socket is fine */ }
  const killedAt = Date.now()
  app.child.kill('SIGKILL')
  await settleWithin(app.exit, 5_000)
  const children = owned.filter((row) => row.pid !== app.pid)
  const reaped = children.map((row) => ({ pid: row.pid, ...signalVerified(row, 'SIGKILL') }))
  const remaining = await waitGone(children, 5_000)
  return { killedAt, exited: app.exited, reaped, remaining: remaining.map(({ pid }) => pid) }
}

/** Cleanup path: every App this fixture opened is ended; failures are evidence, not errors. */
export async function closeAllApps(fixture) {
  const results = []
  for (const app of fixture.apps ?? []) {
    if (app.exited) continue
    try { results.push({ label: app.label, ...(await quitApp(app, fixture)) }) } catch (error) {
      results.push({ label: app.label, error: String(error?.message ?? error), crash: await crashApp(app, fixture).catch((crashError) => String(crashError)) })
    }
  }
  return results
}
