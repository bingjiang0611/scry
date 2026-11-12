import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startTestDaemon, type TestDaemon } from './host-process.harness'
import { cleanupTempDirs } from './host-process.fixtures'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'
import type { ActiveRun } from '../shared/trace'
import { ensureMcpExecutionAuthorized } from '../main/bootstrap/trust'

// B4-V `trust-gate` against a real daemon, through the App's own run surface (what
// `agent:start` calls in daemon mode). The repository MCP config is the scenario's:
// a safe config is auto-authorized after re-verification, a config whose server env
// carries NODE_OPTIONS fails verification and must be refused at the start, with the
// same message the in-process pipeline gives, and never reach the Provider.

// The trust module reads the user's Codex config under HOME at import: a temporary
// HOME keeps the real one out of the fingerprint.
vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join: joinPath } = require('node:path') as typeof import('node:path')
  process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'scry-trust-home-'))
})

const SAFE = '[mcp_servers.b4v_probe]\ncommand = "/bin/echo"\nargs = ["b4v"]\n'
const UNSAFE = `${SAFE}\n[mcp_servers.b4v_probe.env]\nNODE_OPTIONS = "--require=/nonexistent/b4v-trust-probe.js"\n`
const CHANGED_SAFE = '[mcp_servers.b4v_probe]\ncommand = "/bin/echo"\nargs = ["b4v", "changed"]\n'

const encrypt = (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8')
const decrypt = (value: Buffer) => value.toString('utf8').split('').reverse().join('')

afterEach(() => {
  delete process.env.SCRY_HOST_DAEMON
  cleanupTempDirs()
})

function writeConfig(daemon: TestDaemon, text: string): void {
  mkdirSync(join(daemon.workspace, '.codex'), { recursive: true })
  writeFileSync(join(daemon.workspace, '.codex', 'config.toml'), text)
}

function appSurface(daemon: TestDaemon) {
  process.env.SCRY_HOST_DAEMON = '1'
  return createLazyDaemonRunSurface({
    userDataDir: daemon.userDataDir,
    daemonStateDirectory: join(daemon.userDataDir, 'daemon'),
    appVersion: 'test',
    credentialCipher: () => ({ ok: true, encrypt, decrypt }),
    send: () => undefined,
    currentCwd: () => daemon.workspace
  })
}

async function settledView(surface: ReturnType<typeof appSurface>, runId: string): Promise<ActiveRun | null> {
  const deadline = Date.now() + 15_000
  let last: ActiveRun | null = null
  while (Date.now() < deadline) {
    await surface.focusRun(runId)
    last = await surface.focusedRunSnapshot()
    if (last?.done) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return last
}

// The daemon's own ledger, read from disk: the evidence B4-V's ledger check reads.
function ledgerRuns(daemon: TestDaemon): Map<string, Array<{ kind: string; detail?: string; intentId?: string }>> {
  const runs = new Map<string, Array<{ kind: string; detail?: string; intentId?: string }>>()
  const log = readFileSync(join(daemon.userDataDir, 'remote', 'ledger', 'session-ledger.log'), 'utf8')
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as { runId?: string; kind?: string; detail?: string; intentId?: string }
    if (!event.runId || !event.kind) continue
    runs.set(event.runId, [...(runs.get(event.runId) ?? []), { kind: event.kind, ...(event.detail ? { detail: event.detail } : {}), ...(event.intentId ? { intentId: event.intentId } : {}) }])
  }
  return runs
}

// The ledger events of the run started with this prompt (intent ids are scoped per
// grant in the ledger; the routing detail names the prompt).
function runFor(daemon: TestDaemon, prompt: string) {
  return [...ledgerRuns(daemon).values()].find((events) =>
    events.some((event) => event.kind === 'intent_recorded' && event.detail?.includes(`"prompt":${JSON.stringify(prompt)}`))) ?? []
}
const markers = (events: ReturnType<typeof runFor>) => events.flatMap((event) => {
  if (event.kind !== 'run_progress' || !event.detail) return []
  try { return [String((JSON.parse(event.detail) as { event?: unknown }).event)] } catch { return [] }
})

describe('daemon trust gate (B4-V trust-gate)', () => {
  it('refuses a start whose repo MCP config fails verification, like the in-process start, and still auto-grants safe configs', async () => {
    const daemon = await startTestDaemon()
    const surface = appSurface(daemon)
    try {
      writeConfig(daemon, SAFE)
      const safe = await surface.start({ prompt: 'trust-safe', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
      const safeView = await settledView(surface, safe.runId)
      expect(safeView).toMatchObject({ done: true })
      expect(safeView?.error).toBeUndefined()
      expect(markers(runFor(daemon, 'trust-safe'))).toContain('admitted')

      writeConfig(daemon, UNSAFE)
      // What the in-process pipeline's admission says about this config (the control).
      const inProcess = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: daemon.workspace }, 'run')
        .then(() => 'admitted', (error: Error) => error.message)
      expect(inProcess).toMatch(/MCP 配置无法安全执行：.*NODE_OPTIONS/)
      const refusal = await surface.start({ prompt: 'trust-unsafe', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
        .then((receipt) => `accepted ${receipt.runId}`, (error: Error) => error.message)
      expect(refusal).toBe(inProcess)
      // The ledger is honest about it: the intent ended failed with the same reason, no
      // run was admitted, and the Provider never started or produced anything.
      const refused = runFor(daemon, 'trust-unsafe')
      expect(refused.find((event) => event.kind === 'run_failed')?.detail).toBe(inProcess)
      expect(refused.some((event) => event.kind === 'run_settled')).toBe(false)
      expect(markers(refused)).not.toContain('admitted')
      expect(markers(refused)).not.toContain('started')
      expect(markers(refused)).not.toContain('result')

      writeConfig(daemon, CHANGED_SAFE)
      const changed = await surface.start({ prompt: 'trust-changed', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
      const changedView = await settledView(surface, changed.runId)
      expect(changedView).toMatchObject({ done: true })
      expect(changedView?.error).toBeUndefined()
      expect(markers(runFor(daemon, 'trust-changed'))).toContain('admitted')
    } finally {
      surface.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
