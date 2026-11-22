import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { threadId as mainThreadId } from 'node:worker_threads'
import { cryptoProvider } from '@peculiar/x509'
import { build as esbuild } from 'esbuild'
import { createRecentFoldersStore } from '../main/app-store'
import type { WalCheckpointSample } from '../host-runtime/orchestration/db'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { startDeferredLegacyImport } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, tempDir } from './host-process.fixtures'
import { AuthorityMcpTrustGate } from './orchestration-trust-gate'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchOnEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    orch: process.env.SCRY_ORCHESTRATION,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.SCRY_ORCHESTRATION = 'on'
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.orch === undefined) delete process.env.SCRY_ORCHESTRATION
    else process.env.SCRY_ORCHESTRATION = saved.orch
  }
}

describe('W9 Round-4: worker-thread WAL checkpoint proof, SIGKILL block-reservation seq non-reuse, and PATH cache invalidation', () => {
  it('executes backfill WAL checkpoints on a worker thread (0 main-thread wal_checkpoint pragmas, threadId > 0)', async () => {
    const root = tempDir()
    const ledgerDir = join(root, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const lines: string[] = []
    let seq = 0
    for (let i = 0; i < 600; i += 1) {
      const runId = randomUUID()
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: 1_000_000 + i,
          runId,
          kind: 'intent_recorded',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: root, prompt: `worker ckpt proof ${i}` })
        }),
        JSON.stringify({ seq: ++seq, at: 1_000_000 + i + 1, runId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: 1_000_000 + i + 2, runId, kind: 'run_settled' })
      )
    }
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })

    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointFullfsync: true, checkpointIntervalMs: 0 })
    const samples: WalCheckpointSample[] = []
    let mainThreadCheckpointPragmas = 0
    const origPragma = sink.handle.db.pragma.bind(sink.handle.db)
    sink.handle.db.pragma = ((sql: string, opts?: unknown) => {
      if (/wal_checkpoint/i.test(sql)) mainThreadCheckpointPragmas += 1
      return origPragma(sql, opts as never)
    }) as typeof sink.handle.db.pragma

    try {
      sink.setCheckpointObserver((s) => samples.push(s))
      const deferred = startDeferredLegacyImport({
        sink,
        userDataDir: root,
        walCheckpointRuns: 100,
        reconcileOpenRuns: false,
        shadowOnly: true
      })
      const summary = await deferred.promise
      expect(summary.importedRuns).toBe(600)
      expect(samples.length).toBeGreaterThanOrEqual(1)
      expect(mainThreadCheckpointPragmas).toBe(0)
      for (const s of samples) {
        expect((s as WalCheckpointSample & { executor?: string }).executor).toBe('worker')
        const tid = (s as WalCheckpointSample & { threadId?: number }).threadId
        expect(typeof tid).toBe('number')
        expect(tid).toBeGreaterThan(0)
        expect(tid).not.toBe(mainThreadId)
      }
      expect(String(origPragma('locking_mode', { simple: true })).toLowerCase()).toBe('exclusive')
    } finally {
      sink.handle.db.pragma = origPragma
      sink.close()
    }
  }, 30_000)

  it('real SIGKILL after submit under Decision H never reuses seqs and resets stale device cursors to R', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-r12-sigkill')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const cacheDir = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const childSrc = join(root, 'sigkill-r12-entry.ts')
    const childOut = join(cacheDir, `scry-sigkill-r12-${randomUUID()}.mjs`)
    writeFileSync(
      childSrc,
      `
import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from ${JSON.stringify(join(process.cwd(), 'src/daemon/host-process.ts'))}
import { MemoryOutputStore, enrollLocal } from ${JSON.stringify(join(process.cwd(), 'src/daemon/host-process.fixtures.ts'))}

async function main() {
  cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.SCRY_ORCHESTRATION = 'on'
  process.argv.push('--remote-debugging-port=0')

  const [userDataDir, daemonDir] = process.argv.slice(2)
  const host = await createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory: daemonDir,
    appPath: process.cwd(),
    resourcesPath: join(process.cwd(), 'resources'),
    appVersion: 'test',
    isPackaged: false,
    createOutputStore: () => new MemoryOutputStore(),
    log: () => undefined
  })
  const device = await enrollLocal(host.service)
  process.send!({
    ready: true,
    socketPath: host.channel.socketPath,
    ca: host.service.caCertificatePEM,
    cert: device.certPEM,
    key: device.keyPEM
  })
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
    expect(existsSync(childOut)).toBe(true)

    const restore = withOrchOnEnv()
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    const child = fork(childOut, [userDataDir, daemonDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    try {
      const [msg] = (await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`child exited before ready: ${stderr}`) })
      ])) as [{ ready: boolean; socketPath: string; ca: string; cert: string; key: string }]
      expect(msg.ready).toBe(true)

      const intentId = randomUUID()
      const submitted = await call(msg.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'submit',
        intentId,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'r12 sigkill' })
      })
      const runId = submitted.runId as string
      const submitSeq = submitted.seq as number
      expect(submitSeq).toBe(1)

      child.kill('SIGKILL')
      const [, signal] = await exited
      expect(signal).toBe('SIGKILL')

      host2 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory: daemonDir,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const reservedAfterRestart = Number(host2.orchestrationAuthority!.sink.getMeta('h1_seq_reserved_until'))
      expect(reservedAfterRestart).toBe(2048)

      const polled = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, { op: 'poll', cursor: 1 })
      expect(polled.poll.events).toEqual([])
      expect(polled.poll.cursor).toBe(1024)
      expect(polled.poll.reset).toEqual({ requested: 1, availableFrom: 1024 })

      const watched = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'watch',
        runId,
        cursor: 1,
        outputCursor: 0,
        waitMs: 1_000
      })
      expect(watched.error).toBeUndefined()
      expect(['settled', 'cancelled']).toContain(watched.watch.state)

      const resolved = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'resolveIntent',
        intentId
      })
      expect(resolved.intent).toEqual({ runId, state: watched.watch.state })

      const nextSub = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'r12 after sigkill' })
      })
      expect(nextSub.seq).toBe(1025)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      await host2?.dispose()
      rmSync(childOut, { force: true })
      restore()
    }
  }, 30_000)

  it('invalidates MCP trust gate cache when PATH changes for a bare command', () => {
    const root = tempDir()
    const ws = join(root, 'ws-path-cache')
    const binA = join(root, 'bin-a')
    const binB = join(root, 'bin-b')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    mkdirSync(binA, { recursive: true, mode: 0o700 })
    mkdirSync(binB, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)

    const exeA = join(binA, 'scry-bare-mcp')
    const exeB = join(binB, 'scry-bare-mcp')
    writeFileSync(exeA, '#!/bin/sh\necho A\n')
    writeFileSync(exeB, '#!/bin/sh\necho B-different\n')
    chmodSync(exeA, 0o755)
    chmodSync(exeB, 0o755)

    mkdirSync(join(canonicalWs, '.codex'), { recursive: true })
    writeFileSync(
      join(canonicalWs, '.codex', 'config.toml'),
      `[mcp_servers.bare]\ncommand = "scry-bare-mcp"\nargs = []\n`
    )

    let currentPath = `${binA}:${process.env.PATH ?? ''}`
    const gate = new AuthorityMcpTrustGate({
      getEnv: () => ({ ...process.env, PATH: currentPath })
    })
    expect(gate.prepareAndVerify('r1', 'codex', canonicalWs)).toEqual({ ok: true })
    expect(gate.prepareAndVerify('r2', 'codex', canonicalWs)).toEqual({ ok: true })
    expect(gate.rehashCount()).toBe(1)

    currentPath = `${binB}:${process.env.PATH ?? ''}`
    expect(gate.prepareAndVerify('r3', 'codex', canonicalWs)).toEqual({ ok: true })
    expect(gate.rehashCount()).toBe(2)
  })
})
