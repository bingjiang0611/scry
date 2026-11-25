import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseTomlDocument } from '../../cli/mcpguard-core'
import { leakedSecrets, secretMcpTargets } from './argv-recorder.fixture'
import type { AuthorizedMcpExecution } from './types'

// The trust module reads the user's Codex config under HOME at import: a temporary
// HOME keeps the real one out of the fingerprint.
vi.hoisted(() => {
  const { mkdtempSync: mkdtemp } = require('node:fs') as typeof import('node:fs')
  const { tmpdir: tmp } = require('node:os') as typeof import('node:os')
  const { join: joinPath } = require('node:path') as typeof import('node:path')
  process.env.HOME = mkdtemp(joinPath(tmp(), 'scry-codex-argv-home-'))
})

// Codex is launched by Scry itself (no SDK); the spawn options are the argv and env.
const appServer = vi.hoisted(() => ({
  request: vi.fn(),
  shutdown: vi.fn(),
  options: [] as Array<{ args: string[]; env: Record<string, string> }>
}))
vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {},
  CodexAppServerClient: class {
    request = appServer.request
    requestRunning = appServer.request
    start = async () => {}
    onNotification = () => () => {}
    onRequest = () => () => {}
    failureForCurrentGeneration = () => new Promise<Error>(() => {})
    shutdown = appServer.shutdown
    pid = 123
    constructor(options: { args: string[]; env: Record<string, string> }) { appServer.options.push(options) }
    close() {}
  }
}))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  resolveTrustRecorderCliPath: () => undefined,
  runtimeCliEnv: () => ({ PATH: '/usr/bin:/bin' }),
  shellEnv: () => ({}),
  warmShellEnv: async () => ({})
}))

import { codexMcpConfig, createCodexAdapter } from './codex'
import { CODEX_IDLE_DEFAULT_MS } from './codex-client-pool'
import { sweepStalePrivateMcpConfigs } from './private-mcp-config'
import { authorizedMcpExecution, ensureMcpExecutionAuthorized } from '../bootstrap/trust'

let root: string
let privateRoot: string
const originalTmpdir = process.env.TMPDIR

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-codex-argv-')))
  // Private env files go to os.tmpdir(); keep them inside this test's directory.
  privateRoot = join(root, 'private')
  mkdirSync(privateRoot)
  process.env.TMPDIR = privateRoot
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'config.toml'), '[mcp_servers.remote]\nurl = "https://mcp.example.test/mcp"\n')
  appServer.options.length = 0
  appServer.request.mockReset().mockResolvedValue({ data: [] })
  appServer.shutdown.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  if (originalTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmpdir
  rmSync(root, { recursive: true, force: true })
})

const execution = (): AuthorizedMcpExecution => ({
  cwd: root,
  fingerprint: 'sha256:fixture',
  env: { PATH: '/approved/bin' },
  targets: secretMcpTargets
})

type GeneratedServer = { command?: string; args?: string[]; env?: Record<string, string>; [key: string]: unknown }

function generatedServers(args: string[]): Record<string, GeneratedServer> {
  const value = args.find((arg) => arg.startsWith('mcp_servers='))
  expect(value).toBeDefined()
  return parseTomlDocument(value!).mcp_servers as Record<string, GeneratedServer>
}

/** The private env file a launcher-wrapped stdio server reads, or undefined if it is inline. */
const envFileOf = (server: GeneratedServer): string | undefined =>
  server.command === '/bin/sh' ? server.args?.[3] : undefined

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
    expect(servers).not.toContain('"http_headers"=')
    await adapter.dispose?.()
  })

  it('keeps stdio env values out of argv and hands them to the original command through a private file', async () => {
    const adapter = createCodexAdapter(join(root, 'isolated-home'), root)
    await adapter.mcp!.snapshot!({ providerId: 'codex', cwd: root }, true, execution())
    const { args, env } = appServer.options.at(-1)!

    expect(leakedSecrets(args)).toEqual([])
    expect(leakedSecrets(Object.values(env), ['env-secret-2'])).toEqual([])
    const local = generatedServers(args).local
    expect(local).not.toHaveProperty('env')
    expect(local).toEqual({
      command: '/bin/sh',
      args: ['-c', expect.stringContaining('exec "$@"'), 'sh', expect.any(String), '/bin/echo', 'ok'],
      enabled: true
    })
    const file = envFileOf(local)!
    expect(dirname(dirname(file))).toBe(privateRoot)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)

    await adapter.dispose?.()
    expect(existsSync(dirname(file))).toBe(false)
  })

  it('removes the env file when the idle client shuts down, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const adapter = createCodexAdapter(join(root, 'isolated-home'), root)
    await adapter.mcp!.snapshot!({ providerId: 'codex', cwd: root }, true, execution())
    const file = envFileOf(generatedServers(appServer.options.at(-1)!.args).local)
    expect(file).toBeDefined()

    // C1: the pooled client lives for the 20-minute idle window, so the file must survive until then.
    // The pooled client may restart the server until it is shut down.
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_DEFAULT_MS - 1_000)
    expect(existsSync(file!)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await new Promise((resolve) => setImmediate(resolve))
    expect(appServer.shutdown).toHaveBeenCalledTimes(1)
    expect(existsSync(dirname(file!))).toBe(false)
    await adapter.dispose?.()
  })

  it('leaves env files to the startup sweep once their owner is gone', async () => {
    const adapter = createCodexAdapter(join(root, 'isolated-home'), root)
    await adapter.mcp!.snapshot!({ providerId: 'codex', cwd: root }, true, execution())
    const file = envFileOf(generatedServers(appServer.options.at(-1)!.args).local)
    expect(file).toBeDefined()
    const directory = dirname(file!)
    expect(basename(directory)).toMatch(new RegExp(`^scry-mcp-config-${process.pid}-[A-Za-z0-9]{6}$`))

    // A live owner keeps its file; a crashed owner's leftover is removed.
    expect(await sweepStalePrivateMcpConfigs(privateRoot, () => false)).toBe(0)
    const crashed = join(privateRoot, basename(directory).replace(`-${process.pid}-`, '-999999-'))
    renameSync(directory, crashed)
    expect(await sweepStalePrivateMcpConfigs(privateRoot, (pid) => pid !== 999999)).toBe(1)
    expect(existsSync(crashed)).toBe(false)
    await adapter.dispose?.()
  })
})

describe('Codex stdio env launcher', () => {
  const NASTY: Record<string, string> = {
    QUOTES: `it's "quoted" ''`,
    DOLLAR: '$HOME ${PATH} $(id) $((1+1))',
    BACKTICK: '`id` \\`',
    NEWLINES: 'line1\nline2\n\n',
    CR: 'a\r\nb',
    UNICODE: 'ünïcödé ✓ 🚀 中文',
    META: 'a;b && c | d > e < f * ? [x] ~ # !',
    BACKSLASH: 'trailing \\',
    EMPTY: '',
    SPACES: '  padded  ',
    EQUALS: '=a=b=',
    SINGLE: "'"
  }

  const nastyExecution = (printer: string): AuthorizedMcpExecution => ({
    cwd: root,
    fingerprint: 'sha256:fixture',
    env: { PATH: '/usr/bin:/bin' },
    targets: [{ targetId: 'printer', name: 'printer', enabled: true, config: { command: process.execPath, args: [printer], env: NASTY } }]
  })

  /** /bin/sh, plus bash in its `sh` (POSIX) mode as macOS runs it, when this host has bash. */
  function shells(): string[] {
    const found = ['/bin/sh']
    if (existsSync('/bin/bash')) {
      mkdirSync(join(root, 'bash-as-sh'))
      symlinkSync('/bin/bash', join(root, 'bash-as-sh', 'sh'))
      found.push(join(root, 'bash-as-sh', 'sh'))
    }
    return found
  }

  it('gives the original command exactly the env Codex would have given it', () => {
    const printer = join(root, 'print-env.cjs')
    writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.env))\n')
    const config = codexMcpConfig(nastyExecution(printer))
    try {
      expect(leakedSecrets(config.args, Object.values(NASTY).filter((value) => value.trim().length > 3))).toEqual([])
      const server = generatedServers(config.args).printer
      expect(server.args!.slice(4)).toEqual([process.execPath, printer])
      // Codex 0.160.1 starts a stdio server with a cleared env: its default names copied
      // from the app-server env, then the server's `env` on top.
      const codexDefaults = { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: privateRoot }
      // The reference is the env the printer sees when Codex would have started it
      // directly with `env` merged in. Comparing against that run instead of a literal
      // keeps what the OS adds to every process on its own (macOS CoreFoundation sets
      // __CF_USER_TEXT_ENCODING for node) on both sides.
      const direct = spawnSync(process.execPath, [printer], { cwd: root, env: { ...codexDefaults, ...NASTY }, encoding: 'utf8' })
      expect(direct.status, direct.stderr).toBe(0)
      const expected = JSON.parse(direct.stdout) as Record<string, string>
      expect(expected).toMatchObject({ ...codexDefaults, ...NASTY })
      for (const shell of shells()) {
        const result = spawnSync(shell, server.args!, { cwd: root, env: codexDefaults, encoding: 'utf8' })
        expect(result.status, `${shell}: ${result.stderr}`).toBe(0)
        expect(JSON.parse(result.stdout), shell).toEqual(expected)
      }
    } finally {
      config.dispose?.()
    }
  })

  it('does not start the server once the env file is gone', () => {
    const printer = join(root, 'print-env.cjs')
    writeFileSync(printer, 'process.stdout.write("started")\n')
    const config = codexMcpConfig(nastyExecution(printer))
    const server = generatedServers(config.args).printer
    expect(config.dispose).toBeDefined()
    config.dispose?.()
    for (const shell of shells()) {
      const result = spawnSync(shell, server.args!, { cwd: root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
      expect(result.status, shell).not.toBe(0)
      expect(result.stdout, shell).toBe('')
    }
  })

  it('keeps a server inline, unchanged, when the launcher could not reproduce its env exactly', () => {
    // Each would differ under the launcher: the shell refuses or rewrites the name, or
    // Codex itself drops, consumes or case-folds it while building the server env.
    const fallback: Record<string, Record<string, unknown>> = {
      'invalid-name': { 'BAD-NAME': 'v', API_KEY: 'inline-1' },
      'shell-managed': { SHLVL: '3', API_KEY: 'inline-2' },
      'bash-variable': { BASH_ARGV0: 'x', API_KEY: 'inline-3' },
      'codex-dropped': { openai_identity_token_file: '/x', API_KEY: 'inline-4' },
      'codex-protocol': { CODEX_MCP_PROTOCOL_VERSION: '2026-07-28', API_KEY: 'inline-5' },
      'ca-case': { ssl_cert_file: '/ca.pem', API_KEY: 'inline-6' },
      'ca-pair': { NPM_CONFIG_CAFILE: '/ca.pem', API_KEY: 'inline-7' },
      'non-string': { PORT: 8080, API_KEY: 'inline-8' },
      nul: { API_KEY: 'inline-9\0' }
    }
    const stdio = (name: string, config: Record<string, unknown>): AuthorizedMcpExecution['targets'][number] =>
      ({ targetId: name, name, enabled: true, config: { command: '/bin/echo', args: ['ok'], ...config } })
    const config = codexMcpConfig({
      cwd: root,
      fingerprint: 'sha256:fixture',
      env: {},
      targets: [
        ...Object.entries(fallback).map(([name, env]) => stdio(name, { env })),
        stdio('option-command', { command: '-c', env: { API_KEY: 'inline-10' } }),
        stdio('no-env', {}),
        stdio('launched', { env: { SSL_CERT_FILE: '/ca.pem', API_KEY: 'moved-1' } })
      ]
    })
    try {
      const servers = generatedServers(config.args)
      for (const [name, env] of Object.entries(fallback)) {
        expect(servers[name], name).toEqual({ command: '/bin/echo', args: ['ok'], env, enabled: true })
      }
      expect(servers['option-command']).toEqual({ command: '-c', args: ['ok'], env: { API_KEY: 'inline-10' }, enabled: true })
      expect(servers['no-env']).toEqual({ command: '/bin/echo', args: ['ok'], env: {}, enabled: true })
      expect(leakedSecrets(config.args, ['moved-1'])).toEqual([])
      expect(envFileOf(servers.launched)).toBeDefined()
    } finally {
      config.dispose?.()
    }
  })
})

describe('Codex stdio launcher at the trust gate', () => {
  it('still fingerprints and revalidates the original executable, not /bin/sh', async () => {
    const server = join(root, 'server.sh')
    writeFileSync(server, '#!/bin/sh\necho one\n')
    chmodSync(server, 0o700)
    writeFileSync(join(root, '.codex', 'config.toml'),
      `[mcp_servers.local]\ncommand = ${JSON.stringify(server)}\nargs = ["serve"]\n[mcp_servers.local.env]\nAPI_KEY = "env-secret-2"\n`)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snapshot?.targets.find((target) => target.name === 'local')?.executableIdentity).toContain(realpathSync(server))

    const authorized = authorizedMcpExecution(snapshot)!
    const adapter = createCodexAdapter(join(root, 'isolated-home'), root)
    await adapter.mcp!.snapshot!({ providerId: 'codex', cwd: root }, true, authorized)
    const local = generatedServers(appServer.options.at(-1)!.args).local
    expect(local.command).toBe('/bin/sh')
    expect(local.args!.slice(4)).toEqual([realpathSync(server), 'serve'])
    await adapter.dispose?.()

    writeFileSync(server, '#!/bin/sh\necho two\n')
    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(readdirSync(privateRoot)).toEqual([])
  })
})
