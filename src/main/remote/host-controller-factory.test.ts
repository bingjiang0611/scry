import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostController, type HostControllerBinding } from './host-controller-factory'
import { deviceKeyAndCSR } from './inner-mtls-lanes.fixtures'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import type { IssuedPairingCertificate } from './pairing'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../../shared/llm-performance'
import type { RemoteIntentRouting } from './host-controller'

import { attachDaemonOrchestrationAuthority } from '../../daemon/orchestration-authority'
import { ConversationStore } from '../conversation-store'
import { RunRegistry } from '../run-registry'

const HOST = randomUUID() // a stable host identity across restarts (see factory doc)
const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)

const dirs: string[] = []
const bindings: HostControllerBinding[] = []
afterEach(async () => {
  for (const b of bindings.splice(0)) { try { await b.close() } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function factory(stateDirectory: string, startRun: (i: {
  runId: string
  routing: RemoteIntentRouting
  progress(d?: string): void
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
}) => Promise<void>) {
  const workspace = join(stateDirectory, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const authorized = realpathSync(workspace)
  const conversationStore = new ConversationStore(stateDirectory)
  const authority = await attachDaemonOrchestrationAuthority({
    userDataDir: stateDirectory,
    env: {},
    conversationStore: () => conversationStore,
    runs: new RunRegistry(),
    requestRunStop: () => false,
    log: () => undefined
  })
  try {
    const binding = await createHostController({
      stateDirectory,
      hostId: HOST,
      anchorSHA256: ANCHOR,
      verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })),
      issue: vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
        deviceId, certificatePEM: 'synthetic', certificateSHA256: CERT, publicKeySHA256: KEY, expiresAt: Date.now() + 3_600_000
      })),
      authorizeWorkspace: (cwd) => { if (cwd !== authorized) throw new Error('not authorized'); return cwd },
      startRun,
      orchestration: authority.hooks,
      gate: new ProviderOperationGate(),
      createOutputStore: (directory) => new RunOutputFileStore(directory)
    })
    const result = {
      ...binding,
      authority,
      routing: (over: Partial<RemoteIntentRouting> = {}) =>
        JSON.stringify({ cwd: authorized, providerId: 'claude', ...over }),
      close: async () => { try { await binding.close() } finally { await authority.close() } }
    }
    bindings.push(result)
    return result
  } catch (error) {
    await authority.close()
    throw error
  }
}

async function grant(binding: HostControllerBinding) {
  const pair = await binding.controller.authority.begin()
  await binding.controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  await binding.controller.authority.confirmLocal(pair.pairingId, KEY)
}

describe('createHostController (production persistence binding)', () => {
  // The op can be declared and still be dropped between the service deps and the
  // controller; that regression only shows up as tool_panel_unavailable on a
  // paired device, so assert the seam itself.
  it('forwards tool panel sources through the production binding', async () => {
    const toolPanels = {
      analytics: vi.fn(),
      llmPerformance: vi.fn(async (): Promise<[LlmPerformanceHistory, LlmPerformanceSummary]> =>
        [{ rows: [], invalidLines: 0, truncated: false }, { observedAt: 'now', sessions: [] }]),
      mcpTrust: vi.fn()
    }
    const directory = mkdtempSync(join(tmpdir(), 'scry-toolpanels-'))
    dirs.push(directory)
    const binding = await createHostController({
      stateDirectory: directory,
      hostId: HOST,
      anchorSHA256: ANCHOR,
      verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })),
      issue: vi.fn(async ({ deviceId }: { deviceId: string }) => ({
        deviceId, certificatePEM: 'synthetic', certificateSHA256: CERT, publicKeySHA256: KEY, expiresAt: Date.now() + 3_600_000
      })),
      authorizeWorkspace: (cwd) => cwd,
      startRun: vi.fn(async () => {}),
      gate: new ProviderOperationGate(),
      createOutputStore: (directory) => new RunOutputFileStore(directory),
      toolPanels
    })
    bindings.push(binding)
    await grant(binding)
    // A valid kind proves the dependency reached the controller: without the
    // factory spread this rejects with tool_panel_unavailable instead.
    const panel = await binding.controller.readToolPanel(CERT, { kind: 'llmPerformance' })
    expect(panel.kind).toBe('llmPerformance')
    expect(toolPanels.llmPerformance).toHaveBeenCalledTimes(1)
  })

  it('persists pairing and SQLite runs and runs a routed intent through startRun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const seen: RemoteIntentRouting[] = []
    const binding = await factory(dir, async ({ routing }) => { seen.push(routing) })
    await grant(binding)

    const submit = binding.controller.submitIntent(CERT, { intentId: randomUUID(), detail: binding.routing({ prompt: 'go' }) })
    await binding.controller.idle()

    expect(seen).toEqual([{ cwd: realpathSync(join(dir, 'workspace')), providerId: 'claude', prompt: 'go' }])
    expect(binding.authority.sink.getRun(submit.runId)?.lifecycle).toBe('settled')
    expect(existsSync(join(dir, 'pairing'))).toBe(true)
    expect(existsSync(join(dir, 'orchestration', 'orchestration.db'))).toBe(true)
    expect(existsSync(join(dir, 'ledger'))).toBe(false)
    expect(existsSync(join(dir, 'output'))).toBe(true)
  })

  // R5: the outbox row carries the canonical run id while the ledger is keyed by the v4 id
  // `createLedgerIdForSubmit` minted for it, so a non-v4 canonical id found no ledger run. The pump
  // read the throw as a fence conflict and failed the row: the intent was dropped without executing.
  it('R5: dispatches a run whose canonical id is not a v4 uuid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-r5-'))
    dirs.push(dir)
    const started: string[] = []
    const binding = await factory(dir, async ({ runId }) => { started.push(runId) })
    // The conversation marker is only carried by the App's own grant, so this needs a local grant.
    const { csrPEM } = await deviceKeyAndCSR()
    const local = (await binding.controller.authority.enrollLocal({ csrPEM, deviceLabel: 'Scry App' }, () => true))
      .certificateSHA256

    const detail = binding.routing({
      prompt: 'legacy turn',
      conversation: { conversationId: 'conv-r5', runId: 'legacy-turn-7' }
    } as never)
    let leasedTooEarly: unknown
    const execute = binding.authority.sink.execute.bind(binding.authority.sink)
    vi.spyOn(binding.authority.sink, 'execute').mockImplementation((command) => {
      const result = execute(command)
      if (command.type === 'run.submit') queueMicrotask(() => {
        binding.controller.pump()
        leasedTooEarly = binding.authority.sink.handle.db.prepare(
          "SELECT last_error FROM orch_outbox WHERE run_id = 'legacy-turn-7' AND kind = 'provider.run.start'"
        ).pluck().get()
      })
      return result
    })
    const submit = await binding.controller.submitReceivedIntent(local, { intentId: randomUUID(), detail })
    await binding.controller.idle()
    expect(leasedTooEarly).toBeNull()

    expect(started).toEqual(['legacy-turn-7'])
    expect(submit.runId).not.toBe('legacy-turn-7')
    expect(binding.authority.sink.getRun('legacy-turn-7')?.lifecycle).toBe('settled')
  })

  it('replays persisted output pages after a controller restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const first = await factory(dir, async ({ output }) => {
      output({ kind: 'output', text: 'before restart 中😀' })
      output({ kind: 'tool_result', text: 'tool tail' })
    })
    await grant(first)
    const submit = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: first.routing() })
    await first.controller.idle()
    expect((await first.controller.runOutput(CERT, { runId: submit.runId, cursor: 0 })).chunks).toHaveLength(2)
    await first.close()

    const second = await factory(dir, async () => {})
    const page = await second.controller.runOutput(CERT, { runId: submit.runId, cursor: 0 })
    expect(page.chunks.map((chunk) => chunk.text)).toEqual(['before restart 中😀', 'tool tail'])
    expect(page.cursor).toBe(2)
  })

  it('recovers real killed store owners without replaying dispatched work or losing durable output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-crash-'))
    dirs.push(dir)
    const first = await factory(dir, async ({ routing: route, output }) => {
      output({ kind: 'output', text: 'durable before crash' })
      if (route.prompt === 'pending') await new Promise<void>(() => {})
    })
    await grant(first)
    const settled = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: first.routing() })
    await first.controller.idle()
    const pending = first.controller.submitIntent(CERT, { intentId: randomUUID(), detail: first.routing({ prompt: 'pending' }) })
    expect((await first.controller.runOutput(CERT, { runId: pending.runId, cursor: 0 })).chunks).toHaveLength(1)
    await first.close()

    // Execute the actual pairing and output stores in a child, compiled with the
    // project's TypeScript dependency rather than depending on Node's version-specific TS loader.
    for (const name of ['pairing-file', 'run-output-file', 'remote-lease-owner']) {
      const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')
      const output = transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }
      }).outputText
        .replaceAll("from './remote-lease-owner'", "from './remote-lease-owner.mjs'")
        .replaceAll("from '../process-diagnostics'", "from './process-diagnostics.mjs'")
      writeFileSync(join(dir, `${name}.mjs`), output)
    }
    const diagnostics = readFileSync(new URL('../process-diagnostics.ts', import.meta.url), 'utf8')
    writeFileSync(join(dir, 'process-diagnostics.mjs'), transpileModule(diagnostics, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }
    }).outputText)
    const script = join(dir, 'owner.mjs')
    writeFileSync(script, `
      import { PairingFileStore } from './pairing-file.mjs'
      import { RunOutputFileStore } from './run-output-file.mjs'
      import { appendFileSync, readdirSync } from 'node:fs'
      import { join } from 'node:path'
      const root = process.argv[2]
      new PairingFileStore(join(root, 'pairing'))
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
      await expect(factory(dir, async () => {})).rejects.toThrow('owner_alive')
      child.kill('SIGKILL')
      expect((await exited)[1]).toBe('SIGKILL')
      const startRun = vi.fn(async () => {})
      const restored = await factory(dir, startRun)
      expect(restored.authority.sink.getRun(settled.runId)?.lifecycle).toBe('settled')
      // No executor survived the kill: the orphan closes as failed (outcome
      // unknown) instead of staying `dispatched` forever, and is never re-run.
      expect(restored.authority.sink.getRun(pending.runId)?.lifecycle).toBe('interrupted')
      expect(startRun).not.toHaveBeenCalled()
      expect((await restored.controller.runOutput(CERT, { runId: pending.runId, cursor: 0 })).chunks.map((chunk) => chunk.text))
        .toEqual(['durable before crash', 'child durable tail'])
      for (const subdir of ['pairing', 'output']) {
        expect(readdirSync(join(dir, subdir)).filter((name) => name.startsWith('.recovered-'))).toHaveLength(1)
      }
      await expect(restored.controller.runOutput('untrusted-certificate', { runId: pending.runId, cursor: 0 })).rejects.toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('releases all leases when restored state is corrupt, without replacing that state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-corrupt-'))
    dirs.push(dir)
    await (await factory(dir, async () => {})).close()
    const state = join(dir, 'pairing', 'pairing-state.json')
    writeFileSync(state, '{"corrupt":true}', { mode: 0o600 })
    await expect(factory(dir, async () => {})).rejects.toThrow()
    for (const [subdir, lock] of [['pairing', 'pairing-state.lock'], ['output', 'run-output.lock']]) {
      expect(existsSync(join(dir, subdir, lock))).toBe(false)
    }
    expect(readFileSync(state, 'utf8')).toBe('{"corrupt":true}')
  })

  it('releases both leases on close so a restart re-acquires and keeps the grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const first = await factory(dir, async () => {})
    await grant(first)
    const intentId = randomUUID()
    const submit = first.controller.submitIntent(CERT, { intentId, detail: first.routing() })
    await first.controller.idle()
    await first.close()

    // Restart against the same directory: leases re-acquired, grant survives,
    // and the prior settled run is still authoritatively readable.
    const second = await factory(dir, async () => {})
    expect(second.authority.sink.getRun(submit.runId)?.lifecycle).toBe('settled')
    expect(second.controller.intentStatus(CERT, { intentId })).toEqual({ runId: submit.runId, state: 'settled' })
    expect(() => second.controller.intentStatus('f'.repeat(64), { intentId })).toThrow('device_not_authorized')
    expect(second.authority.sink.listEvents()).toContainEqual(expect.objectContaining({ runId: submit.runId, type: 'run.settled' }))
  })

  it('does not leak the pairing lease when the output lease cannot be taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-host-'))
    dirs.push(dir)
    const output = join(dir, 'output')
    mkdirSync(output, { mode: 0o700 })
    const holder = new RunOutputFileStore(output)
    try {
      await expect(factory(dir, async () => {})).rejects.toThrow('owner_alive')
      expect(existsSync(join(dir, 'pairing', 'pairing-state.lock'))).toBe(false)
    } finally {
      await holder.close()
    }
    const reopened = await factory(dir, async () => {})
    expect(reopened.controller).toBeDefined()
  })
})
