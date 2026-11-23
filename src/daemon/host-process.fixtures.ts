import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { Pkcs10CertificateRequestGenerator } from '@peculiar/x509'
import type { createDaemonHostProcess } from './host-process'
import type { OutputChunk, RunOutputStore } from '../main/remote/run-output-log'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'
import type { SubscribeKnownCursor } from '../shared/orchestration-subscribe'


const dirs: string[] = []
export function tempDir(): string {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, 'scry-d-'))
  dirs.push(dir)
  return dir
}
export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export class MemoryOutputStore implements RunOutputStore {
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

export async function enrollLocal(service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service']) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=daemon-device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const csrPEM = csr.toString('pem')
  const grant = await service.enrollLocalDevice({ csrPEM, deviceLabel: 'daemon fixture' }, () => true)
  return { keyPEM, certPEM: grant.certificatePEM }
}

export async function call(socketPath: string, ca: string, cert: string, key: string, request: Record<string, unknown>) {
  const raw: Socket = netConnect(socketPath)
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({ socket: raw, ca, cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
  await once(socket, 'secureConnect')
  socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0]) as Record<string, any>
}

export function localSubscription(known?: SubscribeKnownCursor, waitMs = 0): Record<string, unknown> {
  return {
    op: 'subscribe', views: ['activeRuns', 'sessions'], waitMs,
    ...(known ? { known: { hostId: known.hostId, logId: known.logId, seq: known.seq } } : {})
  }
}

/** Observe one real daemon run using the v3 projection and cursor. */
export async function waitForProjectedRun(
  socketPath: string, ca: string, cert: string, key: string, runId: string, waitMs = 5_000
): Promise<string> {
  const read = (input: Record<string, unknown>) => call(socketPath, ca, cert, key, {
    op: 'subscribe', views: ['activeRuns'], ...input
  })
  let reply = await read({ waitMs: 0 })
  let state = 'dispatched'
  const deadline = Date.now() + 15_000
  const terminal = new Set(['settled', 'failed', 'cancelled', 'interrupted'])
  for (;;) {
    if (reply.error || !reply.subscribe) throw new Error(`subscribe failed: ${JSON.stringify(reply)}`)
    const { hostId, logId, seq, snapshot, events } = reply.subscribe
    const row = snapshot?.activeRuns?.rows?.find((item: { runId: string }) => item.runId === runId) ??
      events?.findLast((item: { runId?: string; runRow?: unknown }) => item.runId === runId && item.runRow)?.runRow
    if (row) state = row.lifecycle
    const lifecycleEvent = events?.findLast((item: { runId?: string; type: string }) =>
      item.runId === runId && item.type.startsWith('run.') && terminal.has(item.type.slice(4)))
    if (lifecycleEvent) state = lifecycleEvent.type.slice(4)
    if (terminal.has(state) || Date.now() >= deadline) return state
    reply = await read({ waitMs, known: { hostId, logId, seq } })
  }
}
