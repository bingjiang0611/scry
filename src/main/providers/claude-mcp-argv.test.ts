import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createArgvRecorder, leakedSecrets, secretMcpTargets, waitFor } from './argv-recorder.fixture'
import type { AuthorizedMcpExecution } from './types'

// The real Claude Agent SDK builds the argv; only the executable is a recorder.
const locate = vi.hoisted(() => ({ executable: '', home: '' }))
vi.mock('../claude-locate', () => ({
  resolveClaudeBin: () => locate.executable,
  runtimeCliEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: locate.home })
}))
vi.mock('../skill-config', () => ({ computeEnabledSkills: () => [], listSkills: () => [] }))

import { createClaudeAdapter } from './claude'

let recorder: ReturnType<typeof createArgvRecorder>
let temp: string

beforeEach(() => {
  recorder = createArgvRecorder()
  locate.executable = recorder.executable
  locate.home = join(recorder.root, 'home')
  temp = join(recorder.root, 'tmp')
  mkdirSync(locate.home)
  mkdirSync(temp)
  // Private MCP config files land under the OS temp directory; keep them in this test's root.
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

describe('Claude MCP configuration stays out of the CLI argv', () => {
  it('passes repository MCP headers, stdio env and the history-reader token through a private file', async () => {
    const handle = createClaudeAdapter(locate.home).run({
      runId: 'run-argv',
      prompt: 'probe',
      cwd: locate.home,
      attachments: [],
      emit: () => {},
      mcpExecution: execution(),
      historyReader: { url: 'http://127.0.0.1:9/mcp', token: 'bearer-secret-3', snapshotId: 'snapshot' }
    })
    await handle.promise.catch(() => {})
    await waitFor(recorder.recorded)
    const record = recorder.record()

    expect(leakedSecrets(record.argv)).toEqual([])
    const servers = (record.config as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['local', 'remote', 'scry_history'])
    expect(servers.remote.headers).toEqual({ 'X-Api-Key': 'hdr-secret-1' })
    expect(servers.local.env).toEqual({ PATH: '/approved/bin', API_KEY: 'env-secret-2' })
    expect(servers.scry_history.headers).toEqual({ Authorization: 'Bearer bearer-secret-3' })
    expect(record.configPath?.startsWith(`${temp}/`)).toBe(true)
    expect(record.fileMode).toBe(0o600)
    expect(record.directoryMode).toBe(0o700)
    expect(existsSync(record.configPath!)).toBe(false)
  })

  it('returns a failed handle and launches nothing when the private file cannot be written', async () => {
    vi.stubEnv('TMPDIR', join(recorder.root, 'missing'))
    const handle = createClaudeAdapter(locate.home).run({
      runId: 'run-unwritable', prompt: 'probe', cwd: locate.home, attachments: [], emit: () => {},
      mcpExecution: execution()
    })
    await expect(handle.promise).rejects.toThrow(/ENOENT/)
    expect(recorder.recorded()).toBe(false)
  })

  it('uses the same private file for the native MCP status check', async () => {
    const adapter = createClaudeAdapter(locate.home)
    const result = await adapter.mcp!.snapshot!({ providerId: 'claude', cwd: locate.home }, true, execution())
    expect(result.state).not.toBe('ready')
    await waitFor(recorder.recorded)
    const record = recorder.record()

    expect(leakedSecrets(record.argv)).toEqual([])
    expect(Object.keys((record.config as { mcpServers: object }).mcpServers).sort()).toEqual(['local', 'remote'])
    expect(record.fileMode).toBe(0o600)
    expect(existsSync(record.configPath!)).toBe(false)
  })
})
