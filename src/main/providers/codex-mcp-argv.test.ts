import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leakedSecrets, secretMcpTargets } from './argv-recorder.fixture'
import type { AuthorizedMcpExecution } from './types'

// Codex is launched by Scry itself (no SDK); the spawn options are the argv and env.
const appServer = vi.hoisted(() => ({ request: vi.fn(), options: [] as Array<{ args: string[]; env: Record<string, string> }> }))
vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {},
  CodexAppServerClient: class {
    request = appServer.request
    requestRunning = appServer.request
    start = async () => {}
    onNotification = () => () => {}
    onRequest = () => () => {}
    failureForCurrentGeneration = () => new Promise<Error>(() => {})
    shutdown = async () => {}
    pid = 123
    constructor(options: { args: string[]; env: Record<string, string> }) { appServer.options.push(options) }
    close() {}
  }
}))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  runtimeCliEnv: () => ({ PATH: '/usr/bin:/bin' }),
  shellEnv: () => ({})
}))

import { createCodexAdapter } from './codex'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-codex-argv-')))
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'config.toml'), '[mcp_servers.remote]\nurl = "https://mcp.example.test/mcp"\n')
  appServer.options.length = 0
  appServer.request.mockReset().mockResolvedValue({ data: [] })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const execution = (): AuthorizedMcpExecution => ({
  cwd: root,
  fingerprint: 'sha256:fixture',
  env: { PATH: '/approved/bin' },
  targets: secretMcpTargets
})

describe('Codex MCP configuration on the app-server argv', () => {
  it('reads static remote headers from the Codex process env instead of argv', async () => {
    const adapter = createCodexAdapter(join(root, 'isolated-home'), root)
    await adapter.mcp!.snapshot!({ providerId: 'codex', cwd: root }, true, execution())
    const { args, env } = appServer.options.at(-1)!

    expect(leakedSecrets(args, ['hdr-secret-1'])).toEqual([])
    const servers = args[args.findIndex((arg) => arg.startsWith('mcp_servers='))]
    const variable = /"remote"=\{[^}]*"env_http_headers"=\{"X-Api-Key"="([A-Z0-9_]+)"\}/.exec(servers)?.[1]
    expect(variable).toBeDefined()
    expect(env[variable!]).toBe('hdr-secret-1')
    expect(servers).not.toContain('http_headers"={')
    // Known residual: Codex has no clean per-server indirection for stdio env (see
    // STATUS-BATCH4 known issues), so its values stay on argv until that is decided.
    expect(leakedSecrets(args, ['env-secret-2'])).toEqual(['env-secret-2'])
  })
})
