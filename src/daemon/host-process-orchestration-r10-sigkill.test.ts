import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

describe('W9 Blocker B3: real SIGKILL recovery from authoritative orchestration.db', () => {
  it('B3: real SIGKILL immediately after submit recovers run from orchestration.db with monotonic seq, watch, and resolveIntent', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-b3-sigkill')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const cacheDir = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const childSrc = join(root, 'sigkill-daemon-entry.ts')
    const childOut = join(cacheDir, `scry-sigkill-${randomUUID()}.mjs`)
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
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'kill right after submit' })
      })
      const runId = submitted.runId as string
      const submitSeq = submitted.seq as number
      expect(runId).toBeTruthy()
      expect(submitSeq).toBeGreaterThanOrEqual(1)

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
      const watched = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'watch', runId, cursor: 0, outputCursor: 0, waitMs: 1_000
      })
      expect(watched.error).toBeUndefined()
      expect(['settled', 'cancelled']).toContain(watched.watch.state)

      const resolved = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'resolveIntent', intentId
      })
      expect(resolved.intent).toEqual({ runId, state: watched.watch.state })

      const nextSub = await call(host2.channel.socketPath, msg.ca, msg.cert, msg.key, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'after sigkill' })
      })
      expect(nextSub.seq).toBeGreaterThan(submitSeq)
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
})
