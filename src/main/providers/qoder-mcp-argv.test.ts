import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createArgvRecorder, leakedSecrets, secretMcpTargets, waitFor } from './argv-recorder.fixture'
import type { AuthorizedMcpExecution } from './types'

// The real Qoder SDK builds the argv; only the executable is a recorder.
const locate = vi.hoisted(() => ({ executable: '', home: '' }))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => locate.executable,
  runtimeCliEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: locate.home }),
  shellEnv: () => ({})
}))

import { createQoderAdapter } from './qoder'
import { readQoderMcpSnapshot } from './qoder-mcp'

let recorder: ReturnType<typeof createArgvRecorder>
let temp: string

beforeEach(() => {
  recorder = createArgvRecorder()
  locate.executable = recorder.executable
  locate.home = join(recorder.root, 'home')
  temp = join(recorder.root, 'tmp')
  mkdirSync(join(locate.home, '.qoder'), { recursive: true })
  mkdirSync(temp)
  // Configured (not yet authorized) servers, so the status path starts the CLI.
  writeFileSync(join(locate.home, '.qoder', 'mcp.json'), JSON.stringify({
    mcpServers: Object.fromEntries(secretMcpTargets.map((target) => [target.name, target.config]))
  }))
  vi.stubEnv('TMPDIR', temp)
})

afterEach(() => {
  vi.unstubAllEnvs()
  recorder.cleanup()
})

const execution = (): AuthorizedMcpExecution => ({
  cwd: locate.home,
  fingerprint: 'sha256:fixture',
  env: { PATH: '/approved/bin' },
  targets: secretMcpTargets
})

function expectPrivateDelivery(record: ReturnType<typeof recorder.record>): void {
  expect(leakedSecrets(record.argv)).toEqual([])
  const servers = (record.config as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers
  expect(servers).toEqual({
    remote: secretMcpTargets[0].config,
    local: { ...secretMcpTargets[1].config, env: { PATH: '/approved/bin', API_KEY: 'env-secret-2' } }
  })
  expect(record.configPath?.startsWith(`${temp}/`)).toBe(true)
  expect(record.fileMode).toBe(0o600)
  expect(record.directoryMode).toBe(0o700)
  expect(existsSync(record.configPath!)).toBe(false)
}

describe('Qoder MCP configuration stays out of the CLI argv', () => {
  it('passes repository MCP headers and stdio env through a private file on a run', async () => {
    const handle = createQoderAdapter(locate.home).run({
      runId: 'run-argv',
      prompt: 'probe',
      cwd: locate.home,
      attachments: [],
      emit: () => {},
      mcpExecution: execution()
    })
    await handle.promise.catch(() => {})
    await waitFor(recorder.recorded)
    expectPrivateDelivery(recorder.record())
  })

  it('fails the run and launches nothing when the private file cannot be written', async () => {
    vi.stubEnv('TMPDIR', join(recorder.root, 'missing'))
    const handle = createQoderAdapter(locate.home).run({
      runId: 'run-unwritable', prompt: 'probe', cwd: locate.home, attachments: [], emit: () => {},
      mcpExecution: execution()
    })
    await expect(handle.promise).rejects.toThrow(/ENOENT/)
    expect(recorder.recorded()).toBe(false)
  })

  it('reports a failed reauthentication without opening a loopback when the file cannot be written', async () => {
    vi.stubEnv('TMPDIR', join(recorder.root, 'missing'))
    const prepareLoopbackCallback = vi.fn()
    const result = await createQoderAdapter(locate.home).mcp!.reauthenticate!(
      { providerId: 'qoder', cwd: locate.home }, 'remote', execution(),
      { openExternal: vi.fn(), prepareLoopbackCallback }
    )
    expect(result.data).toMatchObject({ ok: false, status: 'failed' })
    expect(prepareLoopbackCallback).not.toHaveBeenCalled()
    expect(recorder.recorded()).toBe(false)
  })

  it('uses the same private file for the native MCP status check', async () => {
    await readQoderMcpSnapshot(locate.home, { providerId: 'qoder', cwd: locate.home }, true, execution())
    await waitFor(recorder.recorded)
    expectPrivateDelivery(recorder.record())
  })

  it('keeps the SDK inline form for a config with `tools`, whose SDK rewrite Scry cannot reproduce', async () => {
    const withTools = { ...execution(), targets: [{ ...secretMcpTargets[0], config: { ...secretMcpTargets[0].config, tools: [{ name: 'ping', alwaysLoad: true }] } }] }
    await readQoderMcpSnapshot(locate.home, { providerId: 'qoder', cwd: locate.home }, true, withTools)
    await waitFor(recorder.recorded)
    const record = recorder.record()
    // Known residual exposure, kept on purpose rather than change which tools load.
    expect(record.configPath).toBeUndefined()
    expect((record.config as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.remote)
      .toMatchObject({ headers: { 'X-Api-Key': 'hdr-secret-1' }, toolOverrides: { ping: { alwaysLoad: true } } })
  })
})
