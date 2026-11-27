import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  notifyRecorderInbox,
  recorderDaemonStatus,
  resolveTargetRecorderVersion,
  shouldReplaceDaemon,
  startRecorderDaemon,
  stopRecorderDaemon
} from './daemon'
import { handleRecorderHook } from './recorder'
import { recorderInboxEntries } from './inbox'
import { RECORDER_VERSION, listRecords, safeKey } from './store'
import type { RecorderOpenTurnState } from './runtime-state'

let bundleDir = ''
let cliEntry = ''
const roots: string[] = []
const children: ChildProcess[] = []
const workspacesToStop: Array<{ workspace: string; env: NodeJS.ProcessEnv }> = []

beforeAll(async () => {
  bundleDir = await realpath(await mkdtemp(join(tmpdir(), 'scry-handoff-cli-')))
  cliEntry = join(bundleDir, 'scry.mjs')
  await build({
    entryPoints: [resolve('src/cli/scry.ts')],
    outfile: cliEntry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
}, 30_000)

afterAll(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true })
})

afterEach(async () => {
  for (const item of workspacesToStop.splice(0)) {
    await stopRecorderDaemon(item.workspace, item.env, { drainWaitMs: 500, sigtermWaitMs: 300, sigkillWaitMs: 300 }).catch(() => undefined)
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createWorkspace(prefix: string): Promise<{ root: string; socketPath: string; env: NodeJS.ProcessEnv }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'daemon-handoff-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const socketPath = join(tmpdir(), `${basename(root)}.sock`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, 'state'),
    SCRY_GRANT_DIR: join(root, 'grants'),
    SCRY_AUTO_UPDATE: '0',
    SCRY_NO_UPDATE_CHECK: '1',
    SCRY_RECORDER_SOCKET: socketPath
  }
  workspacesToStop.push({ workspace: root, env })
  return { root, socketPath, env }
}

async function spawnStubDaemon(args: {
  root: string
  socketPath: string
  version: string
  mode: 'graceful-delay' | 'ignore-stop' | 'ignore-sigterm'
  delayMs?: number
}): Promise<{ child: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> {
  const scriptPath = join(args.root, `stub-daemon-${args.mode}.mjs`)
  const script = [
    "import { createServer } from 'node:http'",
    "import { rm, writeFile } from 'node:fs/promises'",
    `const socketPath = ${JSON.stringify(args.socketPath)}`,
    `const version = ${JSON.stringify(args.version)}`,
    `const mode = ${JSON.stringify(args.mode)}`,
    `const delayMs = ${args.delayMs ?? 0}`,
    "const markerPath = `${socketPath}.owner.json`",
    "if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {})",
    "let stopping = false",
    "const server = createServer((req, res) => {",
    "  req.resume()",
    "  const json = (code, body) => {",
    "    const text = JSON.stringify(body)",
    "    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })",
    "    res.end(text)",
    "  }",
    "  if (req.url === '/v1/status') {",
    "    json(200, { running: true, protocol: '2', recorderVersion: version, pid: process.pid, socketPath })",
    "    return",
    "  }",
    "  if (req.url === '/v1/stop') {",
    "    json(200, { ok: true })",
    "    if (mode === 'graceful-delay' && !stopping) {",
    "      stopping = true",
    "      setTimeout(() => {",
    "        server.close(async () => {",
    "          await rm(socketPath, { force: true })",
    "          await rm(markerPath, { force: true })",
    "          process.exit(0)",
    "        })",
    "      }, delayMs)",
    "    }",
    "    return",
    "  }",
    "  json(409, { ok: false, error: 'recorder version mismatch', recorderVersion: version })",
    "})",
    "await rm(socketPath, { force: true })",
    "await new Promise((r) => server.listen(socketPath, r))",
    "await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, pid: process.pid, instanceId: 'stub-' + process.pid, state: 'running', createdAt: Date.now(), recorderVersion: version, socketPath }))",
    "process.stdout.write('READY\\n')"
  ].join('\n')
  await writeFile(scriptPath, script)
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.includes('READY')) resolveReady()
    })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', rejectReady)
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) rejectReady(new Error(`stub exited ${code}: ${stderr}`))
    })
  })
  return { child, exited }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}

describe('recorder daemon handoff', () => {
  it('resolves target version from recorder package.json and only replaces strictly older daemons', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-target-version-')
    const pkgRoot = join(root, 'pkg')
    const binDir = join(pkgRoot, 'dist', 'cli')
    await mkdir(binDir, { recursive: true })
    const fakeCli = join(binDir, 'scry.js')
    await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@ali/scry-turn-recorder', version: '0.2.89' }))
    await writeFile(fakeCli, 'export {}\n')

    expect(await resolveTargetRecorderVersion(fakeCli)).toBe('0.2.89')
    expect(shouldReplaceDaemon('0.2.88', '0.2.89')).toBe(true)
    expect(shouldReplaceDaemon('0.2.89', '0.2.89')).toBe(false)
    expect(shouldReplaceDaemon('0.2.91', '0.2.89')).toBe(false)
    expect(shouldReplaceDaemon(undefined, '0.2.89')).toBe(true)
    expect(shouldReplaceDaemon('not-semver', '0.2.89')).toBe(false)

    const { child } = await spawnStubDaemon({ root, socketPath, version: '0.2.91', mode: 'ignore-stop' })
    const result = await startRecorderDaemon({ workspace: root, scriptPath: fakeCli, env })
    expect(result.started).toBe(false)
    expect(result.status.recorderVersion).toBe('0.2.91')
    expect(child.exitCode).toBeNull()
  }, 20_000)

  it('waits for a busy older daemon to drain gracefully without forced stop', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-graceful-drain-')
    const { exited } = await spawnStubDaemon({ root, socketPath, version: '0.2.91', mode: 'graceful-delay', delayMs: 1_200 })

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'graceful-session', prompt: 'queued before handoff' },
      queueOnly: true,
      env
    })

    const started = await startRecorderDaemon({
      workspace: root,
      scriptPath: cliEntry,
      drainWaitMs: 5_000,
      env
    })
    expect(started.started).toBe(true)
    expect(started.status.recorderVersion).toBe(RECORDER_VERSION)
    expect(await exited).toEqual({ code: 0, signal: null })

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('graceful-session'))
    const open = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
        return (await recorderInboxEntries(sessionRoot)).length === 0 ? parsed : null
      } catch {
        return null
      }
    })
    expect(open.prompt).toBe('queued before handoff')
    expect(await recorderInboxEntries(sessionRoot)).toEqual([])
    const log = await readFile(join(root, '.scry', 'logs', 'recorder.log'), 'utf8').catch(() => '')
    expect(log).not.toContain('daemon_handoff_forced_stop')
  }, 30_000)

  it('performs non-blocking detached handoff from notifyRecorderInbox without losing queued events', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-detach-handoff-')
    const { exited } = await spawnStubDaemon({ root, socketPath, version: '0.2.91', mode: 'graceful-delay', delayMs: 1_200 })

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'detach-session', prompt: 'first queued event' },
      queueOnly: true,
      env
    })

    const t0 = Date.now()
    const firstNotify = await notifyRecorderInbox({ workspace: root, scriptPath: cliEntry, env })
    const firstElapsed = Date.now() - t0
    expect(firstNotify).toBe('started')
    expect(firstElapsed).toBeLessThan(800)

    await new Promise((r) => setTimeout(r, 150))
    const t1 = Date.now()
    const secondNotify = await notifyRecorderInbox({ workspace: root, scriptPath: cliEntry, env })
    const secondElapsed = Date.now() - t1
    expect(secondNotify).toBe('started')
    expect(secondElapsed).toBeLessThan(800)

    expect(await exited).toEqual({ code: 0, signal: null })
    const status = await waitFor(async () => {
      const current = await recorderDaemonStatus(root, env)
      return current.running && current.recorderVersion === RECORDER_VERSION ? current : null
    }, 15_000)
    expect(status.recorderVersion).toBe(RECORDER_VERSION)

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('detach-session'))
    const open = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
        return (await recorderInboxEntries(sessionRoot)).length === 0 ? parsed : null
      } catch {
        return null
      }
    }, 10_000)
    expect(open.prompt).toBe('first queued event')
    expect(await recorderInboxEntries(sessionRoot)).toEqual([])
  }, 30_000)

  it('escalates to SIGTERM when a wedged daemon ignores /v1/stop, logs only reason and versions, and recovers the turn', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-force-sigterm-')
    const secretPrompt = 'SECRET_PROMPT_CONTENT_NEVER_LOG_123'
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'wedged-term', prompt: secretPrompt },
      env
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { session_id: 'wedged-term' },
      queueOnly: true,
      env
    })

    const { exited } = await spawnStubDaemon({ root, socketPath, version: '0.2.91', mode: 'ignore-stop' })
    const started = await startRecorderDaemon({
      workspace: root,
      scriptPath: cliEntry,
      drainWaitMs: 250,
      sigtermWaitMs: 1_500,
      sigkillWaitMs: 500,
      env
    })
    expect(started.started).toBe(true)
    expect(started.status.recorderVersion).toBe(RECORDER_VERSION)
    expect((await exited).signal).toBe('SIGTERM')

    const log = await readFile(join(root, '.scry', 'logs', 'recorder.log'), 'utf8')
    expect(log).toContain(`WARN daemon_handoff_forced_stop reason=graceful_drain_timeout signal=SIGTERM fromVersion=0.2.91 toVersion=${RECORDER_VERSION}`)
    expect(log).not.toContain(root)
    expect(log).not.toContain(secretPrompt)

    const records = await waitFor(async () => {
      const list = await listRecords(join(root, '.scry'))
      return list.length > 0 ? list : null
    }, 10_000)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('completed')
    expect(records[0].user.value?.text).toBe(secretPrompt)
    expect(records[0].recorderVersion).toBe(RECORDER_VERSION)
  }, 30_000)

  it('escalates to SIGKILL when a wedged daemon ignores both /v1/stop and SIGTERM, preserving open turn state', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-force-sigkill-')
    const secretPrompt = 'SECRET_OPEN_TURN_NEVER_LOG_456'
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'wedged-kill', prompt: secretPrompt },
      env
    })

    const { exited } = await spawnStubDaemon({ root, socketPath, version: '0.2.88', mode: 'ignore-sigterm' })
    const started = await startRecorderDaemon({
      workspace: root,
      scriptPath: cliEntry,
      drainWaitMs: 200,
      sigtermWaitMs: 250,
      sigkillWaitMs: 1_500,
      env
    })
    expect(started.started).toBe(true)
    expect(started.status.recorderVersion).toBe(RECORDER_VERSION)
    expect((await exited).signal).toBe('SIGKILL')

    const log = await readFile(join(root, '.scry', 'logs', 'recorder.log'), 'utf8')
    expect(log).toContain(`WARN daemon_handoff_forced_stop reason=graceful_drain_timeout signal=SIGKILL fromVersion=0.2.88 toVersion=${RECORDER_VERSION}`)
    expect(log).not.toContain(root)
    expect(log).not.toContain(secretPrompt)

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('wedged-kill'))
    const open = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
    expect(open.prompt).toBe(secretPrompt)
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  }, 30_000)

  it('replaces a real older serve child process mid-session and seals the turn under the new version', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-mixed-serve-')
    const oldPkg = join(root, 'old-pkg')
    await mkdir(oldPkg, { recursive: true })
    const oldEntry = join(oldPkg, 'scry.mjs')
    const bundleSource = await readFile(cliEntry, 'utf8')
    const patchedSource = bundleSource.replaceAll(`"${RECORDER_VERSION}"`, '"0.2.91"')
    expect(patchedSource).not.toBe(bundleSource)
    await writeFile(join(oldPkg, 'package.json'), JSON.stringify({ name: '@ali/scry-turn-recorder', version: '0.2.91' }))
    await writeFile(oldEntry, patchedSource)

    const oldStart = await startRecorderDaemon({ workspace: root, scriptPath: oldEntry, env })
    expect(oldStart.started).toBe(true)
    expect(oldStart.status.recorderVersion).toBe('0.2.91')

    await new Promise<void>((resolveHook, rejectHook) => {
      const child = spawn(process.execPath, [oldEntry, 'recorder', 'hook', '--provider', 'claude', '--event', 'UserPromptSubmit', '--workspace', root], {
        env, stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', rejectHook)
      child.on('exit', (code) => code === 0 ? resolveHook() : rejectHook(new Error(`old hook exit ${code}: ${stderr}`)))
      child.stdin.end(JSON.stringify({ session_id: 'mixed-serve-session', prompt: 'started on 0.2.91' }))
    })

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('mixed-serve-session'))
    const openBefore = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
    expect(openBefore.prompt).toBe('started on 0.2.91')

    await new Promise<void>((resolveHook, rejectHook) => {
      const child = spawn(process.execPath, [cliEntry, 'recorder', 'hook', '--provider', 'claude', '--event', 'Stop', '--workspace', root], {
        env, stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', rejectHook)
      child.on('exit', (code) => code === 0 ? resolveHook() : rejectHook(new Error(`new hook exit ${code}: ${stderr}`)))
      child.stdin.end(JSON.stringify({ session_id: 'mixed-serve-session' }))
    })

    const afterStatus = await recorderDaemonStatus(root, env)
    expect(afterStatus.running).toBe(true)
    expect(afterStatus.recorderVersion).toBe(RECORDER_VERSION)

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('completed')
    expect(records[0].user.value?.text).toBe('started on 0.2.91')
    expect(records[0].recorderVersion).toBe(RECORDER_VERSION)
    expect(await recorderInboxEntries(sessionRoot)).toEqual([])
  }, 45_000)

  it('returns within Stop budget while a busy older daemon drains for over 3s and hands off cleanly', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-busy-budget-')
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'busy-budget', prompt: 'opened before busy stop' },
      env
    })

    const { exited } = await spawnStubDaemon({
      root,
      socketPath,
      version: '0.2.91',
      mode: 'graceful-delay',
      delayMs: 3_500
    })

    const startedAt = Date.now()
    await new Promise<void>((resolveHook, rejectHook) => {
      const child = spawn(process.execPath, [cliEntry, 'recorder', 'hook', '--provider', 'claude', '--event', 'Stop', '--workspace', root], {
        env, stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', rejectHook)
      child.on('exit', (code) => code === 0 ? resolveHook() : rejectHook(new Error(`hook exit ${code}: ${stderr}`)))
      child.stdin.end(JSON.stringify({ session_id: 'busy-budget' }))
    })
    const hookElapsedMs = Date.now() - startedAt
    expect(hookElapsedMs).toBeLessThan(5_000)

    expect(await exited).toEqual({ code: 0, signal: null })
    const afterStatus = await waitFor(async () => {
      const current = await recorderDaemonStatus(root, env)
      return current.running && current.recorderVersion === RECORDER_VERSION ? current : null
    }, 15_000)
    expect(afterStatus.recorderVersion).toBe(RECORDER_VERSION)

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('busy-budget'))
    const records = await waitFor(async () => {
      const list = await listRecords(join(root, '.scry')).catch(() => [])
      return list.length > 0 && (await recorderInboxEntries(sessionRoot)).length === 0 ? list : null
    }, 15_000)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('completed')
    expect(records[0].recorderVersion).toBe(RECORDER_VERSION)
    const log = await readFile(join(root, '.scry', 'logs', 'recorder.log'), 'utf8').catch(() => '')
    expect(log).not.toContain('daemon_handoff_forced_stop')
  }, 45_000)

  it('completes detached handoff and consumes the queued Stop event even if the hook is SIGKILLed immediately', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-hook-killed-')
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'killed-hook', prompt: 'survives hook sigkill' },
      env
    })

    const { exited } = await spawnStubDaemon({
      root,
      socketPath,
      version: '0.2.91',
      mode: 'graceful-delay',
      delayMs: 1_800
    })

    const lockPath = join(root, '.scry', 'locks', 'daemon-start.lock')
    const hookChild = spawn(process.execPath, [cliEntry, 'recorder', 'hook', '--provider', 'claude', '--event', 'Stop', '--workspace', root], {
      env, stdio: ['pipe', 'ignore', 'pipe']
    })
    children.push(hookChild)
    const hookExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      hookChild.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    hookChild.stdin.end(JSON.stringify({ session_id: 'killed-hook' }))

    await waitFor(async () => {
      try {
        await access(lockPath)
        return true
      } catch {
        return null
      }
    }, 5_000)
    hookChild.kill('SIGKILL')
    expect((await hookExited).signal).toBe('SIGKILL')

    expect(await exited).toEqual({ code: 0, signal: null })
    const afterStatus = await waitFor(async () => {
      const current = await recorderDaemonStatus(root, env)
      return current.running && current.recorderVersion === RECORDER_VERSION ? current : null
    }, 15_000)
    expect(afterStatus.recorderVersion).toBe(RECORDER_VERSION)

    const sessionRoot = join(root, '.scry', 'runtime', 'claude', safeKey('killed-hook'))
    const records = await waitFor(async () => {
      const list = await listRecords(join(root, '.scry')).catch(() => [])
      return list.length > 0 && (await recorderInboxEntries(sessionRoot)).length === 0 ? list : null
    }, 15_000)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('completed')
    expect(records[0].user.value?.text).toBe('survives hook sigkill')
    expect(records[0].recorderVersion).toBe(RECORDER_VERSION)
  }, 45_000)
})
