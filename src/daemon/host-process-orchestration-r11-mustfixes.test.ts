import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { startDeferredLegacyImport } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'
import { AuthorityMcpTrustGate, fileStatStamp } from './orchestration-trust-gate'

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

async function waitTerminal(socketPath: string, ca: string, cert: string, key: string, runId: string): Promise<string> {
  let state = 'dispatched'
  let cursor = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !['settled', 'failed', 'cancelled'].includes(state)) {
    const res = await call(socketPath, ca, cert, key, { op: 'watch', runId, cursor, outputCursor: 0, waitMs: 5_000 })
    state = res.watch.state
    cursor = res.watch.poll.cursor
  }
  return state
}

describe('W9 Round-3 Must-Fixes 1, 2, 3: off-thread worker checkpoint, cross-run MCP cache, and symlink target stat', () => {
  it('Must-Fix 1: worker-thread WAL checkpoint runs off-main-thread during backfill and restores EXCLUSIVE locking_mode on finish', async () => {
    const root = tempDir()
    const ledgerDir = join(root, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const lines: string[] = []
    let seq = 0
    for (let i = 0; i < 600; i += 1) {
      const runId = randomUUID()
      lines.push(
        JSON.stringify({ seq: ++seq, at: 1_000_000 + i, runId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: root, prompt: `run ${i}` }) }),
        JSON.stringify({ seq: ++seq, at: 1_000_000 + i + 1, runId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: 1_000_000 + i + 2, runId, kind: 'run_settled' })
      )
    }
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })

    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointFullfsync: true, checkpointIntervalMs: 0 })
    try {
      expect(String(sink.handle.db.pragma('locking_mode', { simple: true })).toLowerCase()).toBe('exclusive')
      const deferred = startDeferredLegacyImport({
        sink,
        userDataDir: root,
        walCheckpointRuns: 100,
        reconcileOpenRuns: false,
        shadowOnly: true
      })
      const summary = await deferred.promise
      expect(summary.importedRuns).toBe(600)
      expect(sink.checkpointCount()).toBeGreaterThanOrEqual(1)
      expect(String(sink.handle.db.pragma('locking_mode', { simple: true })).toLowerCase()).toBe('exclusive')
    } finally {
      sink.close()
    }
  })

  it('Must-Fix 2 + 3: caches MCP executable fingerprint across runs and detects in-place mutation of symlinked config target', async () => {
    const root = tempDir()
    const ws = join(root, 'ws-mcp')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)

    // Create a symlink `.mcp.json` -> target file inside workspace containing a real executable (`process.execPath`).
    const targetFile = join(canonicalWs, 'real-mcp-config.json')
    writeFileSync(
      targetFile,
      JSON.stringify({
        mcpServers: {
          real_node: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 1000)']
          }
        }
      })
    )
    const linkPath = join(canonicalWs, '.mcp.json')
    symlinkSync(targetFile, linkPath)

    const stampBefore = fileStatStamp(linkPath)
    expect(stampBefore).toContain('|T:')

    // Cross-run caching: 5 distinct runs in the same workspace only hash the executable ONCE!
    const gate = new AuthorityMcpTrustGate()
    for (let i = 0; i < 5; i += 1) {
      const res = gate.prepareAndVerify(`run-${i}`, 'claude', canonicalWs)
      expect(res).toEqual({ ok: true })
    }
    expect(gate.rehashCount()).toBe(1)

    // In-place mutation of the symlink TARGET file (symlink itself untouched) MUST change fileStatStamp and trigger rehash!
    writeFileSync(targetFile, '{broken symlink target json')
    const stampAfter = fileStatStamp(linkPath)
    expect(stampAfter).not.toBe(stampBefore)

    const rejected = gate.prepareAndVerify('run-after-mutation', 'claude', canonicalWs)
    expect(rejected.ok).toBe(false)
    expect(gate.rehashCount()).toBe(2)

    // End-to-end real daemon check with symlinked `.codex/config.toml` target mutated in place between runs:
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    const codexDir = join(canonicalWs, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const codexTarget = join(canonicalWs, 'codex-mcp-target.toml')
    const safeToml = `[mcp_servers.real_node]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-v"]\n`
    const unsafeToml = `${safeToml}\n[mcp_servers.real_node.env]\nNODE_OPTIONS = "--require=/nonexistent/probe.js"\n`
    writeFileSync(codexTarget, safeToml)
    symlinkSync(codexTarget, join(codexDir, 'config.toml'))

    const restore = withOrchOnEnv()
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
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
      const ca = host.service.caCertificatePEM

      const run1 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'valid symlinked mcp' })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, run1.runId)).toBe('settled')

      // Mutate the symlink target in place (without touching the symlink itself) -> next run MUST fail closed!
      writeFileSync(codexTarget, unsafeToml)
      const run2 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'must reject unsafe symlink target' })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, run2.runId)).toBe('failed')
    } finally {
      await host?.dispose()
      restore()
    }
  })
})
