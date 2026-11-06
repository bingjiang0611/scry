import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDaemonHostProcess } from './host-process'
import type { OutputChunk, RunOutputStore } from '../main/remote/run-output-log'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-host-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class MemoryOutputStore implements RunOutputStore {
  private readonly chunks: OutputChunk[] = []
  append(chunk: Omit<OutputChunk, 'seq'>): OutputChunk {
    const next = { ...chunk, seq: (this.chunks.at(-1)?.seq ?? 0) + 1 }
    this.chunks.push(next)
    return next
  }
  since(runId: string, cursor: number) {
    const chunks = this.chunks.filter((chunk) => chunk.runId === runId && chunk.seq > cursor)
    return { chunks, cursor: chunks.at(-1)?.seq ?? cursor }
  }
  close(): void {}
}

describe('daemon host process', () => {
  it('assembles the run pipeline and host, serves only a unix socket, and disposes it', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const ledgerDirectory = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    const ledgerStore = new SessionLedgerFileStore(ledgerDirectory)
    const ledger = new SessionLedger({ store: ledgerStore })
    const orphan = randomUUID()
    ledger.recordIntent({
      intentId: randomUUID(),
      runId: orphan,
      detail: JSON.stringify({ cwd: root, providerId: 'claude', prompt: 'unknown outcome' })
    })
    ledger.markDispatched(orphan)
    ledgerStore.close()

    const oldRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    try {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      expect(host.channel.socketPath).toBe(join(daemonStateDirectory, 'local.sock'))
      expect(existsSync(host.channel.socketPath)).toBe(true)
      expect(host.service.relayConfigured).toBe(false)
      const recovered = readFileSync(join(ledgerDirectory, 'session-ledger.log'), 'utf8')
      expect(recovered).toContain(`\"runId\":\"${orphan}\"`)
      expect(recovered).toContain('run_failed')
      expect(recovered).toContain('host_restarted')
      await host.dispose()
      expect(existsSync(host.channel.socketPath)).toBe(false)
    } finally {
      if (oldRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = oldRelay
    }
  }, 30_000)
})
