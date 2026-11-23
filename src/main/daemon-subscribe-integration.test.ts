import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build as esbuild } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAdminNotice } from '../shared/host-admin'
import type { TraceEvent } from '../shared/trace'
import type { TraceBatch } from './trace-output'
import { cleanupTempDirs, tempDir } from '../daemon/host-process.fixtures'
import { startTestDaemon } from '../daemon/host-process.harness'
import { createRecentFoldersStore } from './app-store'
import { DaemonClient, daemonClientPaths } from './daemon-client'
import { DaemonRunTransport } from './daemon-run-transport'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { startDaemonRunEvents } from './daemon-run-events'
import { createDaemonRunSurface } from './bootstrap/daemon-run-surface'
import { laneForRequest } from './remote/desktop-lane'

afterEach(() => {
  vi.unstubAllEnvs()
  cleanupTempDirs()
})

describe('P4-3 local subscribe App integration (W16 Unit 3)', () => {
  it('drives lifecycle via subscribe with 0 watch / 0 liveRuns / 0 settledTail / 0 appEvents, reads archive on post-settle trace, and delivers W11 hostNotice', async () => {
    const daemon = await startTestDaemon()
    const ops: Array<{ op: string; settledTail?: unknown }> = []
    const deliveredTraces: TraceEvent[] = []
    const turnDoneEvents: Array<Record<string, unknown>> = []
    const hostNotices: HostAdminNotice[] = []

    const transport = new DaemonRunTransport(async (request) => {
      const op = String(request.op ?? '')
      const query = request.query as Record<string, unknown> | undefined
      ops.push({ op, ...(query?.settledTail !== undefined ? { settledTail: query.settledTail } : {}) })
      // Delay trace reads slightly so post-settle trace exercises archive fallback (no settledTail).
      if (op === 'desktop' && query?.kind === 'trace') {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return await daemon.request(request)
    })

    const runtime = new DaemonRunRuntime({
      transport,
      send: (channel, payload) => {
        if (channel === 'agent:trace') deliveredTraces.push(...(payload as TraceBatch).events)
        else if (channel === 'agent:turnDone') turnDoneEvents.push(payload as Record<string, unknown>)
      }
    })
    const surface = createDaemonRunSurface({
      transport,
      runtime,
      currentCwd: () => daemon.workspace
    })
    const events = startDaemonRunEvents({
      transport,
      runtime,
      send: (channel, payload) => {
        if (channel === 'agent:turnDone') turnDoneEvents.push(payload as Record<string, unknown>)
      },
      onHostAdmin: (notice) => hostNotices.push(notice),
      waitMs: 500
    })

    try {
      const commandId = randomUUID()
      const started = await surface.start({
        prompt: 'subscribe e2e test',
        providerId: 'codex',
        cwd: daemon.workspace,
        commandId
      })
      expect(started.runId).toBeTruthy()

      await expect.poll(() => runtime.runView(started.runId)?.done, { timeout: 10_000 }).toBe(true)
      await expect.poll(
        () => deliveredTraces.some((e) => e.runId === started.runId && e.kind === 'harness' && e.stage === 'result'),
        { timeout: 5_000 }
      ).toBe(true)
      await expect.poll(
        () => turnDoneEvents.filter((e) => e.runId === started.runId).length,
        { timeout: 3_000 }
      ).toBe(1)
      // Terminal archive fallback must deliver `harness/result` at most once (never re-emit live items).
      expect(
        deliveredTraces.filter((e) => e.runId === started.runId && e.kind === 'harness' && e.stage === 'result')
      ).toHaveLength(1)

      // External run submitted directly on daemon socket is discovered via subscribe without liveRuns
      const extIntent = randomUUID()
      const extSub = await daemon.request({
        op: 'submit',
        intentId: extIntent,
        detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'codex', prompt: 'external run' })
      })
      await expect.poll(() => runtime.isTracking(extSub.runId as string), { timeout: 5_000 }).toBe(true)

      // activeRuns() uses subscribed state, never liveRuns
      await surface.activeRuns()

      // W11 host-admin notice arrives via subscribe hostNotice hint with exact payload
      const recorded = daemon.host.hostAdmin.recordNotice({
        kind: 'device_approved_via_cli',
        deviceLabel: 'W16Phone',
        fingerprintPrefix: 'abcdef0123456789'
      })
      await expect.poll(() => hostNotices.some((n) => n.id === recorded.id), { timeout: 5_000 }).toBe(true)
      expect(hostNotices.find((n) => n.id === recorded.id)).toEqual(recorded)

      // Discovery alone is not a terminal condition. Leave the test daemon
      // open until the externally submitted run has published completion.
      await expect.poll(() => {
        const external = runtime.runView(extSub.runId as string)
        return external?.done && turnDoneEvents.some((event) => event.runId === external.runId)
      }, { timeout: 5_000 }).toBe(true)

      // Verify commandId landed in orch_command
      const cmdCount = (
        daemon.host.orchestrationAuthority!.sink.handle.db
          .prepare('SELECT COUNT(*) AS c FROM orch_command WHERE type = ?')
          .get('run.submit') as { c: number }
      ).c
      expect(cmdCount).toBeGreaterThanOrEqual(2)

      // Hard assertions: ZERO watch, ZERO liveRuns, ZERO settledTail, ZERO appEvents
      expect(ops.filter((o) => o.op === 'subscribe').length).toBeGreaterThan(0)
      expect(ops.filter((o) => o.op === 'watch')).toHaveLength(0)
      expect(ops.filter((o) => o.op === 'liveRuns')).toHaveLength(0)
      expect(ops.filter((o) => o.op === 'appEvents')).toHaveLength(0)
      expect(ops.filter((o) => o.settledTail === true)).toHaveLength(0)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 45_000)

  it('a stale off environment still delivers runs on the subscription path', async () => {
    vi.stubEnv('SCRY_ORCHESTRATION', 'off')
    const daemon = await startTestDaemon()
    const ops: string[] = []
    const transport = new DaemonRunTransport(async (request) => {
      ops.push(String(request.op ?? ''))
      return await daemon.request(request)
    })
    const runtime = new DaemonRunRuntime({ transport, send: () => undefined })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined, waitMs: 500 })
    try {
      const started = await surface.start({
        prompt: 'obsolete off setting',
        providerId: 'codex',
        cwd: daemon.workspace,
        commandId: randomUUID()
      })
      await expect.poll(() => runtime.runView(started.runId)?.done, { timeout: 10_000 }).toBe(true)
      expect(ops.includes('appEvents')).toBe(false)
      expect(ops.includes('watch')).toBe(false)
      expect(ops.includes('subscribe')).toBe(true)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 30_000)

  it('restart + logId reset: resyncs from snapshot without losing run state or emitting duplicate turnDone', async () => {
    let daemon = await startTestDaemon()
    const root = daemon.root
    const turnDoneEvents: Array<Record<string, unknown>> = []
    const logIdChanges: Array<{ prev: string; next: string }> = []

    const transport = new DaemonRunTransport(async (request) => await daemon.request(request))
    const runtime = new DaemonRunRuntime({
      transport,
      send: (channel, payload) => {
        if (channel === 'agent:turnDone') turnDoneEvents.push(payload as Record<string, unknown>)
      }
    })
    const surface = createDaemonRunSurface({
      transport,
      runtime,
      currentCwd: () => daemon.workspace
    })
    const events = startDaemonRunEvents({
      transport,
      runtime,
      send: (channel, payload) => {
        if (channel === 'agent:turnDone') turnDoneEvents.push(payload as Record<string, unknown>)
      },
      onLogIdChanged: (prev, next) => logIdChanges.push({ prev, next }),
      waitMs: 300
    })

    try {
      const run = await surface.start({
        prompt: 'before restart',
        providerId: 'codex',
        cwd: daemon.workspace,
        commandId: randomUUID()
      })
      await expect.poll(() => runtime.runView(run.runId)?.done, { timeout: 10_000 }).toBe(true)
      await expect.poll(() => turnDoneEvents.filter((e) => e.runId === run.runId).length, { timeout: 3_000 }).toBe(1)

      // Restart daemon on same root and rotate log_id to force a snapshot reset
      await daemon.dispose()
      daemon = await startTestDaemon({ root })
      daemon.host.orchestrationAuthority!.sink.setMeta('log_id', `rotated-${randomUUID()}`)

      // Wait for pump to reconnect and detect logId change + snapshot resync
      await expect.poll(() => logIdChanges.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)

      // Run view is preserved and turnDone was NOT emitted a second time
      expect(runtime.runView(run.runId)?.done).toBe(true)
      expect(turnDoneEvents.filter((e) => e.runId === run.runId)).toHaveLength(1)

      // Subsequent run after reset still works seamlessly
      const run2 = await surface.start({
        prompt: 'after reset',
        providerId: 'codex',
        cwd: daemon.workspace,
        commandId: randomUUID()
      })
      await expect.poll(() => runtime.runView(run2.runId)?.done, { timeout: 10_000 }).toBe(true)
      await expect.poll(() => turnDoneEvents.filter((e) => e.runId === run2.runId).length, { timeout: 3_000 }).toBe(1)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 45_000)

  it('SIGKILL + reconnect: real child daemon killed with SIGKILL, relaunched, App reconnects over subscribe cleanly', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspaceDir = join(root, 'workspace')
    mkdirSync(join(userDataDir, 'remote', 'ledger'), { recursive: true, mode: 0o700 })
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
    const workspace = realpathSync(workspaceDir)
    createRecentFoldersStore(userDataDir).push(workspace)

    const cacheDir = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const childSrc = join(root, 'sigkill-w16-entry.ts')
    const childOut = join(cacheDir, `scry-sigkill-w16-${randomUUID()}.mjs`)
    writeFileSync(
      childSrc,
      `
import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from ${JSON.stringify(join(process.cwd(), 'src/daemon/host-process.ts'))}
import { MemoryOutputStore } from ${JSON.stringify(join(process.cwd(), 'src/daemon/host-process.fixtures.ts'))}

async function main() {
  cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.argv.push('--remote-debugging-port=0')
  const [userData, daemonState] = process.argv.slice(2)
  const host = await createDaemonHostProcess({
    userDataDir: userData,
    daemonStateDirectory: daemonState,
    appPath: process.cwd(),
    resourcesPath: join(process.cwd(), 'resources'),
    appVersion: '0.0.1-test',
    isPackaged: false,
    createOutputStore: () => new MemoryOutputStore(),
    log: () => undefined
  })
  process.send!({ ready: true })
  process.on('SIGTERM', async () => { await host.dispose(); process.exit(0) })
  setInterval(() => {}, 1000)
}
main().catch((err) => { console.error(err); process.exit(1) })
`
    )
    await esbuild({
      entryPoints: [childSrc],
      outfile: childOut,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external'
    })

    let childStderr = ''
    const spawnChildDaemon = async () => {
      childStderr = ''
      const child = fork(childOut, [userDataDir, daemonStateDirectory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      child.stderr?.on('data', (chunk) => { childStderr = (childStderr + String(chunk)).slice(-8000) })
      const exited = once(child, 'exit')
      const [msg] = (await Promise.race([
        once(child, 'message'),
        exited.then(([code]) => { throw new Error(`child daemon exited ${code}: ${childStderr}`) })
      ])) as [{ ready: boolean }]
      expect(msg.ready).toBe(true)
      return child
    }

    let child = await spawnChildDaemon()
    const client = new DaemonClient({
      paths: daemonClientPaths(daemonStateDirectory, userDataDir),
      appVersion: '0.0.1-test',
      encrypt: (v) => Buffer.from(v, 'utf8'),
      decrypt: (v) => v.toString('utf8')
    })

    let events: { dispose(): void } | undefined
    let runtime: DaemonRunRuntime | undefined
    try {
      await client.connect()
      expect(client.subscribeSupported).toBe(true)

      const transport = new DaemonRunTransport(async (request, options) => {
        return await client.request(laneForRequest(request), request, {
          replayable: options?.replayable ?? false,
          ...(options?.signal ? { signal: options.signal } : {})
        })
      })
      const turnDone: string[] = []
      runtime = new DaemonRunRuntime({
        transport,
        send: (channel, payload) => {
          if (channel === 'agent:turnDone') turnDone.push(String((payload as { runId?: string }).runId ?? ''))
        }
      })
      const surface = createDaemonRunSurface({
        transport,
        runtime,
        currentCwd: () => workspace
      })
      events = startDaemonRunEvents({
        transport,
        runtime,
        send: () => undefined,
        waitMs: 300
      })

      // First run before SIGKILL
      const r1 = await surface.start({ prompt: 'before sigkill', providerId: 'codex', cwd: workspace, commandId: randomUUID() })
      await expect.poll(() => runtime!.runView(r1.runId)?.done, { timeout: 10_000 }).toBe(true)

      // Capture the App notification before killing the transport that delivers it.
      await expect.poll(() => turnDone.filter((id) => id === r1.runId).length, { timeout: 3_000 }).toBe(1)

      // Hard-kill child daemon with SIGKILL
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      client.close()

      // Relaunch daemon on same directories and reconnect client
      child = await spawnChildDaemon()
      await client.connect()
      expect(client.subscribeSupported).toBe(true)

      // App pump recovers and second run succeeds cleanly
      const r2 = await surface.start({ prompt: 'after sigkill', providerId: 'codex', cwd: workspace, commandId: randomUUID() }).catch(async (error) => {
        const evidence = await transport.subscribe({ views: ['activeRuns'], waitMs: 0 })
          .catch(() => undefined)
        throw new Error(`post-restart start failed: ${JSON.stringify(evidence)}\n${childStderr}`, { cause: error })
      })
      await expect.poll(() => runtime!.runView(r2.runId)?.done, { timeout: 10_000 }).toBe(true)
      await expect.poll(() => turnDone.filter((id) => id === r2.runId).length, { timeout: 3_000 }).toBe(1)
      expect(turnDone.filter((id) => id === r1.runId)).toHaveLength(1)
    } finally {
      events?.dispose()
      runtime?.dispose()
      client.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000)
          child.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
      rmSync(childOut, { force: true })
    }
  }, 60_000)
})
