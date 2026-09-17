import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostController, type HostControllerBinding } from './host-controller-factory'
import { ProviderOperationGate } from '../provider-operation-gate'
import type { IssuedPairingCertificate } from './pairing'
import type { RemoteIntentRouting } from './host-controller'

const HOST = randomUUID() // a stable host identity across restarts (see factory doc)
const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)
const AUTHORIZED = '/authorized/project'

const dirs: string[] = []
const bindings: HostControllerBinding[] = []
afterEach(() => {
  for (const b of bindings.splice(0)) { try { b.close() } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function factory(stateDirectory: string, startRun: (i: {
  runId: string
  routing: RemoteIntentRouting
  progress(d?: string): void
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
}) => Promise<void>) {
  const binding = createHostController({
    stateDirectory,
    hostId: HOST,
    anchorSHA256: ANCHOR,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })),
    issue: vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
      deviceId, certificatePEM: 'synthetic', certificateSHA256: CERT, publicKeySHA256: KEY, expiresAt: Date.now() + 3_600_000
    })),
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun,
    gate: new ProviderOperationGate()
  })
  bindings.push(binding)
  return binding
}

const routing = (over: Partial<RemoteIntentRouting> = {}) => JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

async function grant(binding: HostControllerBinding) {
  const pair = await binding.controller.authority.begin()
  await binding.controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  await binding.controller.authority.confirmLocal(pair.pairingId, KEY)
}

describe('createHostController (production persistence binding)', () => {
  it('persists pairing + ledger on real disk and runs a routed intent through startRun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const seen: RemoteIntentRouting[] = []
    const binding = factory(dir, async ({ routing }) => { seen.push(routing) })
    await grant(binding)

    const submit = binding.controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await binding.controller.idle()

    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }])
    expect(binding.controller.runState(CERT, { runId: submit.runId })).toBe('settled')
    expect(existsSync(join(dir, 'pairing'))).toBe(true)
    expect(existsSync(join(dir, 'ledger'))).toBe(true)
    expect(existsSync(join(dir, 'output'))).toBe(true)
  })

  it('replays persisted output pages after a controller restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const first = factory(dir, async ({ output }) => {
      output({ kind: 'output', text: 'before restart 中😀' })
      output({ kind: 'tool_result', text: 'tool tail' })
    })
    await grant(first)
    const submit = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await first.controller.idle()
    expect(first.controller.runOutput(CERT, { runId: submit.runId, cursor: 0 }).chunks).toHaveLength(2)
    first.close()

    const second = factory(dir, async () => {})
    const page = second.controller.runOutput(CERT, { runId: submit.runId, cursor: 0 })
    expect(page.chunks.map((chunk) => chunk.text)).toEqual(['before restart 中😀', 'tool tail'])
    expect(page.cursor).toBe(2)
  })

  it('recovers real killed store owners without replaying dispatched work or losing durable output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-crash-'))
    dirs.push(dir)
    const first = factory(dir, async ({ routing: route, output }) => {
      output({ kind: 'output', text: 'durable before crash' })
      if (route.prompt === 'pending') await new Promise<void>(() => {})
    })
    await grant(first)
    const settled = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await first.controller.idle()
    const pending = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'pending' }) })
    expect(first.controller.runOutput(CERT, { runId: pending.runId, cursor: 0 }).chunks).toHaveLength(1)
    first.close()

    // Execute the actual three file-store implementations in a child, compiled with the
    // project's TypeScript dependency rather than depending on Node's version-specific TS loader.
    for (const name of ['pairing-file', 'session-ledger-file', 'run-output-file']) {
      const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')
      writeFileSync(join(dir, `${name}.mjs`), transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }
      }).outputText)
    }
    const script = join(dir, 'owner.mjs')
    writeFileSync(script, `
      import { PairingFileStore } from './pairing-file.mjs'
      import { SessionLedgerFileStore } from './session-ledger-file.mjs'
      import { RunOutputFileStore } from './run-output-file.mjs'
      import { appendFileSync, readdirSync } from 'node:fs'
      import { join } from 'node:path'
      const root = process.argv[2]
      new PairingFileStore(join(root, 'pairing'))
      new SessionLedgerFileStore(join(root, 'ledger'))
      const output = new RunOutputFileStore(join(root, 'output'))
      output.append({ runId: process.argv[3], kind: 'output', text: 'child durable tail', at: Date.now() })
      const data = join(root, 'output')
      for (const name of readdirSync(data)) {
        if (name.endsWith('.jsonl')) appendFileSync(join(data, name), '{"uncommitted":')
        if (name.endsWith('.idx')) appendFileSync(join(data, name), Buffer.from([1, 2, 3]))
      }
      process.send('ready')
      setInterval(() => {}, 1000)
    `)
    const child = fork(script, [dir, pending.runId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr!.on('data', (data) => { stderr += String(data) })
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`store owner exited before readiness: ${stderr}`) })
      ])
      expect(ready[0]).toBe('ready')
      expect(() => factory(dir, async () => {})).toThrow('owner_alive')
      child.kill('SIGKILL')
      expect((await exited)[1]).toBe('SIGKILL')
      const startRun = vi.fn(async () => {})
      const restored = factory(dir, startRun)
      expect(restored.controller.runState(CERT, { runId: settled.runId })).toBe('settled')
      expect(restored.controller.runState(CERT, { runId: pending.runId })).toBe('dispatched')
      expect(startRun).not.toHaveBeenCalled()
      expect(restored.controller.runOutput(CERT, { runId: pending.runId, cursor: 0 }).chunks.map((chunk) => chunk.text))
        .toEqual(['durable before crash', 'child durable tail'])
      for (const subdir of ['pairing', 'ledger', 'output']) {
        expect(readdirSync(join(dir, subdir)).filter((name) => name.startsWith('.recovered-'))).toHaveLength(1)
      }
      expect(() => restored.controller.runOutput('untrusted-certificate', { runId: pending.runId, cursor: 0 })).toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('releases all leases when restored state is corrupt, without replacing that state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-corrupt-'))
    dirs.push(dir)
    factory(dir, async () => {}).close()
    const state = join(dir, 'pairing', 'pairing-state.json')
    writeFileSync(state, '{"corrupt":true}', { mode: 0o600 })
    expect(() => factory(dir, async () => {})).toThrow()
    for (const [subdir, lock] of [['pairing', 'pairing-state.lock'], ['ledger', 'session-ledger.lock'], ['output', 'run-output.lock']]) {
      expect(existsSync(join(dir, subdir, lock))).toBe(false)
    }
    expect(readFileSync(state, 'utf8')).toBe('{"corrupt":true}')
  })

  it('releases both leases on close so a restart re-acquires and keeps the grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const first = factory(dir, async () => {})
    await grant(first)
    const submit = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await first.controller.idle()
    first.close()

    // Restart against the same directory: leases re-acquired, grant survives,
    // and the prior settled run is still authoritatively readable.
    const second = factory(dir, async () => {})
    expect(second.controller.runState(CERT, { runId: submit.runId })).toBe('settled')
    // The restored grant still authorizes the device.
    expect(() => second.controller.poll(CERT, { cursor: 0 })).not.toThrow()
  })

  it('does not leak the pairing lease when the ledger lease cannot be taken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const holder = factory(dir, async () => {}) // holds both leases
    // A second binding on the same dir must fail (ledger lease busy) and must
    // not leave a dangling pairing lease; closing the holder proves the dir is
    // fully released afterwards.
    expect(() => factory(dir, async () => {})).toThrow()
    holder.close()
    const reopened = factory(dir, async () => {})
    expect(reopened.controller).toBeDefined()
  })
})
