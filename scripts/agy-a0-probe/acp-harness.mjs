// Shared ACP stdio client & isolated temp-dir helpers for Antigravity A0 probes.
// Never mutates the user's real `~/.gemini`; always installs a no-op BROWSER exiting 0.
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

export const CLIENT_INFO = { name: 'scry', version: '0.2.250' }
export const CLIENT_CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
export const REAL_GEMINI_DIR = join(homedir(), '.gemini')

export function resolveAgyBin(override) {
  return override ?? execFileSync('/usr/bin/which', ['agy'], { encoding: 'utf8' }).trim()
}

export function scrubSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/ya29\.[A-Za-z0-9._-]+/g, '<OAUTH_TOKEN>')
      .replace(/AIza[A-Za-z0-9_-]+/g, '<API_KEY>')
      .replace(/https:\/\/accounts\.google\.com\/[^\s"']+/g, '<GOOGLE_OAUTH_URL>')
      .replace(/https:\/\/[^\s"']*[?&](?:code|state|token)=[^\s"']+/gi, '<AUTH_URL_REDACTED>')
      .replace(/scry-probe-secret-[a-f0-9]+/g, '<PROBE_MCP_TOKEN>')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL_REDACTED>')
  }
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v)
    return out
  }
  return value
}

export function createTempTracker() {
  const dirs = []
  return {
    make(prefix) {
      const d = realpathSync(mkdtempSync(`/tmp/${prefix}-`))
      chmodSync(d, 0o700)
      dirs.push(d)
      return d
    },
    cleanup() {
      for (const d of dirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
}

export function makeFakeBrowser(dir) {
  const logPath = join(dir, 'browser-calls.log')
  const binPath = join(dir, 'fake-browser.sh')
  writeFileSync(binPath, `#!/bin/sh\necho "BROWSER_CALLED:$*" >> "${logPath}"\nexit 0\n`, { mode: 0o700 })
  return {
    binPath,
    readCalls: () => (existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(scrubSecrets)
      : [])
  }
}

/** Creates an isolated 0700 temp gemini-dir; optionally copies legacy file token if present. */
export function makeIsolatedGeminiDir(root, { withToken = true, settings = {}, config = null } = {}) {
  const gdir = join(root, '.gemini')
  const cliDir = join(gdir, 'antigravity-cli')
  const cfgDir = join(gdir, 'config')
  mkdirSync(cliDir, { recursive: true, mode: 0o700 })
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
  if (withToken) {
    const src = join(REAL_GEMINI_DIR, 'antigravity-cli', 'antigravity-oauth-token')
    if (existsSync(src)) {
      const dst = join(cliDir, 'antigravity-oauth-token')
      copyFileSync(src, dst)
      chmodSync(dst, 0o600)
    }
  }
  if (settings !== null) {
    writeFileSync(join(cliDir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 })
  }
  if (config !== null) {
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
  }
  return gdir
}

export function startAcp({ agyBin, cwd, extraArgs = [], env = {}, geminiDir, browserBin, stripSsh = true }) {
  const spawnArgs = ['acp', ...(geminiDir ? ['--gemini-dir', geminiDir] : []), ...extraArgs]
  const childEnv = { ...process.env, BROWSER: browserBin, ...env }
  if (stripSsh) {
    delete childEnv.SSH_CLIENT
    delete childEnv.SSH_CONNECTION
    delete childEnv.SSH_TTY
  }
  const startedAt = Date.now()
  const child = spawn(agyBin, spawnArgs, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
  let nextId = 1
  const pending = new Map()
  const notifications = []
  const incomingRequests = []
  const nonJsonStdout = []
  const stderrChunks = []
  let permissionHandler = null

  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try { msg = JSON.parse(trimmed) } catch {
      nonJsonStdout.push({ t: Date.now() - startedAt, line: scrubSecrets(trimmed.slice(0, 300)) })
      return
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id)
      if (entry) { pending.delete(msg.id); entry.resolve({ elapsedMs: Date.now() - entry.sentAt, msg }) }
      return
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      incomingRequests.push({ t: Date.now() - startedAt, msg })
      if (permissionHandler) Promise.resolve(permissionHandler(msg, respond)).catch(() => undefined)
      else respond(msg.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    notifications.push({ t: Date.now() - startedAt, msg })
  })
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')))

  const sendRaw = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`)
  const respond = (id, result, error) => sendRaw(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
  const notify = (method, params) => sendRaw({ jsonrpc: '2.0', method, params })
  const request = (method, params, timeoutMs = 45_000) => {
    const id = nextId++
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => { pending.delete(id); rejectReq(new Error(`rpc_timeout:${method}:${timeoutMs}ms`)) }, timeoutMs)
      pending.set(id, { sentAt: Date.now(), resolve: (res) => { clearTimeout(timer); resolveReq(res) } })
      sendRaw({ jsonrpc: '2.0', id, method, params })
    })
  }
  const waitExit = (timeoutMs = 10_000) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false, elapsedMs: 0 })
    }
    const start = Date.now()
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit({ code: child.exitCode, signal: child.signalCode, timedOut: true, elapsedMs: Date.now() - start }), timeoutMs)
      child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal, timedOut: false, elapsedMs: Date.now() - start }) })
    })
  }
  const close = async (graceMs = 5_000) => {
    try { child.stdin.end() } catch { /* ignore */ }
    const natural = await waitExit(graceMs)
    if (!natural.timedOut) return { natural: true, ...natural }
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* ignore */ }
    const termed = await waitExit(5_000)
    if (!termed.timedOut) return { natural: false, escalated: 'SIGTERM', ...termed }
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ }
    const killed = await waitExit(3_000)
    return { natural: false, escalated: 'SIGKILL', ...killed }
  }
  return {
    child, request, notify, respond, close, waitExit,
    setPermissionHandler: (fn) => { permissionHandler = fn },
    get notifications() { return notifications },
    get incomingRequests() { return incomingRequests },
    get nonJsonStdout() { return nonJsonStdout },
    stderrTail: () => scrubSecrets(stderrChunks.join('').slice(-1500))
  }
}
