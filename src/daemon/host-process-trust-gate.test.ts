import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startTestDaemon, type TestDaemon } from './host-process.harness'
import { cleanupTempDirs } from './host-process.fixtures'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'
import type { ActiveRun } from '../shared/trace'
import { ensureMcpExecutionAuthorized } from '../main/bootstrap/trust'


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

function runFor(daemon: TestDaemon, prompt: string) {
  const sink = daemon.host.orchestrationAuthority!.sink
  const row = sink.handle.db.prepare('SELECT run_id FROM orch_p_run WHERE prompt_preview = ?').get(prompt) as { run_id: string }
  return {
    projection: sink.getRun(row.run_id)!,
    events: sink.listEvents().filter((event) => event.runId === row.run_id)
  }
}

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
      expect(runFor(daemon, 'trust-safe').events.map((event) => event.type)).toContain('run.admitted')

      writeConfig(daemon, UNSAFE)
      const inProcess = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: daemon.workspace }, 'run')
        .then(() => 'admitted', (error: Error) => error.message)
      expect(inProcess).toMatch(/MCP 配置无法安全执行：.*NODE_OPTIONS/)
      const refusal = await surface.start({ prompt: 'trust-unsafe', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
        .then((receipt) => `accepted ${receipt.runId}`, (error: Error) => error.message)
      expect(refusal).toBe(inProcess)
      const refused = runFor(daemon, 'trust-unsafe')
      expect(refused.projection).toMatchObject({ lifecycle: 'failed', outputSeq: null })
      expect(refused.events.find((event) => event.type === 'run.failed')?.payload)
        .toMatchObject({ reason: 'trust_gate_rejected', detail: inProcess })
      expect(refused.events.map((event) => event.type)).not.toContain('run.settled')
      expect(refused.events.map((event) => event.type)).not.toContain('run.admitted')
      expect(refused.events.map((event) => event.type)).not.toContain('run.dispatched')
      expect(daemon.output.since(refused.projection.runId, 0).chunks).toEqual([])

      writeConfig(daemon, CHANGED_SAFE)
      const changed = await surface.start({ prompt: 'trust-changed', providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID() })
      const changedView = await settledView(surface, changed.runId)
      expect(changedView).toMatchObject({ done: true })
      expect(changedView?.error).toBeUndefined()
      expect(runFor(daemon, 'trust-changed').events.map((event) => event.type)).toContain('run.admitted')
    } finally {
      surface.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
