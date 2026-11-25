import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { build as esbuild } from 'esbuild'
import { createRecentFoldersStore } from '../main/app-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchOnEnv(inputsPath: string) {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    inputs: process.env.SCRY_ELECTRON_SMOKE_INPUTS,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.SCRY_ELECTRON_SMOKE_INPUTS = inputsPath
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    for (const [key, value] of [
      ['SCRY_REMOTE_RELAY_ENABLED', saved.relay],
      ['SCRY_ELECTRON_SMOKE_PROVIDER', saved.smoke],
      ['SCRY_ELECTRON_SMOKE_INPUTS', saved.inputs],
      ['ELECTRON_ENABLE_LOGGING', saved.logging]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * R2: a queued entry used to be rebuilt as `cancelled` with its request body dropped, so after a
 * restart the queue head was admitted by the authority while the ledger insisted the run was
 * cancelled. `markDispatched` threw, the pump read that as "someone else dispatched it" and succeeded
 * the outbox row: the run sat in `dispatched` forever and never executed.
 */
describe('R2: a queued entry survives a SIGKILL and then runs exactly once', () => {
  it('dispatches the queued run after the restart, once, with its original request', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-r2-queued')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const cacheDir = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const childSrc = join(root, 'queued-daemon-entry.ts')
    const childOut = join(cacheDir, `scry-r2-queued-${randomUUID()}.mjs`)
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

    const inputsPath = join(root, 'provider-inputs.jsonl')
    const restore = withOrchOnEnv(inputsPath)
    const inputs = () => readFileSync(inputsPath, 'utf8').trim().split('\n').map(row => JSON.parse(row) as { prompt: string; resume: string })
    let restarted: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    const child = fork(childOut, [userDataDir, daemonDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    try {
      const [ready] = (await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`child exited before ready: ${stderr}`) })
      ])) as [{ ready: boolean; socketPath: string; ca: string; cert: string; key: string }]
      expect(ready.ready).toBe(true)

      const nativeSid = randomUUID()
      // A question-driven head keeps the session live until it is answered, so the second submit is
      // genuinely queued instead of racing a fast fixture.
      const head = await call(ready.socketPath, ready.ca, ready.cert, ready.key, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({
          cwd: canonicalWs, providerId: 'codex', prompt: 'llm performance smoke', resume: nativeSid
        })
      })
      expect(head.error).toBeUndefined()
      const headRunId = head.runId as string
      const headDeadline = Date.now() + 10_000
      let headLifecycle = 'recorded'
      while (Date.now() < headDeadline && headLifecycle === 'recorded') {
        const reply = await call(ready.socketPath, ready.ca, ready.cert, ready.key, {
          op: 'subscribe', views: ['activeRuns'], trackedRunIds: [headRunId], waitMs: 0
        })
        headLifecycle = reply.subscribe?.snapshot.activeRuns.rows.find((row: { runId: string }) => row.runId === headRunId)?.lifecycle ?? headLifecycle
      }
      expect(headLifecycle).toBe('dispatched')
      await vi.waitFor(() => expect(inputs().map(row => row.prompt)).toEqual(['llm performance smoke']), { timeout: 5_000 })

      const prompt = '排队后重启，这条只能跑一次'
      const queuedIntentId = randomUUID()
      const submitted = await call(ready.socketPath, ready.ca, ready.cert, ready.key, {
        op: 'submit',
        intentId: queuedIntentId,
        mode: 'queue',
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt, resume: nativeSid })
      })
      expect(submitted.error).toBeUndefined()
      const runId = submitted.runId as string
      expect(runId).toBeTruthy()

      const queued = await call(ready.socketPath, ready.ca, ready.cert, ready.key, {
        op: 'subscribe', views: ['activeRuns'], trackedRunIds: [runId], waitMs: 0
      })
      const queuedRow = queued.subscribe.snapshot.activeRuns.rows.find((row: { runId: string }) => row.runId === runId)
      expect(queuedRow?.lifecycle).toBe('queued')
      expect(inputs().map(row => row.prompt)).toEqual(['llm performance smoke'])

      child.kill('SIGKILL')
      const [, signal] = await exited
      expect(signal).toBe('SIGKILL')

      restarted = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory: daemonDir,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })

      const deadline = Date.now() + 15_000
      let lifecycle = 'queued'
      while (Date.now() < deadline) {
        const reply = await call(restarted.channel.socketPath, ready.ca, ready.cert, ready.key, {
          op: 'subscribe', views: ['activeRuns'], trackedRunIds: [runId], waitMs: 0
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!reply.subscribe) throw new Error(`subscribe failed after restart: ${JSON.stringify(reply)}`)
        const row = reply.subscribe.snapshot.activeRuns.rows.find((item: { runId: string }) => item.runId === runId)
        if (row) lifecycle = row.lifecycle
        if (['settled', 'failed', 'cancelled', 'interrupted'].includes(lifecycle)) break
      }
      expect(lifecycle).toBe('settled')

      const events = restarted.orchestrationAuthority!.sink.listEvents()
      const mine = events.filter((event) => event.runId === runId)
      // Exactly one dispatch, so the restart did not double-run the entry.
      expect(mine.filter((event) => event.type === 'run.dispatched')).toHaveLength(1)
      // Count executions independently of the dispatch journal, across both daemon processes.
      expect(inputs().map(({ prompt, resume }) => ({ prompt, resume }))).toEqual([
        { prompt: 'llm performance smoke', resume: nativeSid },
        { prompt, resume: nativeSid }
      ])
      const resolved = await call(restarted.channel.socketPath, ready.ca, ready.cert, ready.key, {
        op: 'resolveIntent', intentId: queuedIntentId
      })
      expect(resolved.intent?.state).toBe('settled')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      await restarted?.dispose()
      rmSync(childOut, { force: true })
      restore()
    }
  }, 40_000)
})
