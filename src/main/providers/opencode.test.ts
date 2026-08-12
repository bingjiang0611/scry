import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Dispatcher } from 'undici'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderRunRequest } from './types'

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/opencode',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import {
  createOpenCodeAdapter,
  emitOpenCodeHookEvents,
  emitOpenCodeEvent,
  handleOpenCodePermission,
  handleOpenCodeQuestion,
  openCodePermissionRules,
  openCodeRunControlCatalog,
  openCodeSkillScope
} from './opencode'
import {
  assertOpenCodeProjectProjection,
  createOpenCodeFetch,
  isolatedOpenCodeChildEnv,
  OPEN_CODE_LONG_REQUEST_TIMEOUTS,
  OpenCodeServerManager,
  OpenCodeProjectPluginSecurityError,
  openCodeMcpCredentialKey,
  openCodeMcpAuthSeed,
  openCodeMcpConfig,
  openCodeMcpAuthFile,
  openCodeHookObserverSource,
  openCodeHookTraceCursor,
  openCodeSessionDatabase,
  openCodeSafeConfig,
  openCodeServerAuthorization,
  persistOpenCodeMcpAuth,
  persistPrivateOpenCodeMcpAuth,
  readOpenCodeHookTrace,
  readOpenCodeProjectProjection,
  sanitizeOpenCodeAuth,
  sanitizeOpenCodeServerLog,
  type OpenCodeProjectProjection,
  type OpenCodeServerState,
  writeOpenCodePluginSnapshots
} from './opencode-server'

describe('OpenCode provider adapter', () => {
  it('forwards only local api/oauth credentials and drops wellknown remote configuration auth', () => {
    expect(sanitizeOpenCodeAuth({
      anthropic: { type: 'api', key: 'api-key' },
      openai: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 },
      'https://remote.example': { type: 'wellknown', key: 'remote', token: 'token' },
      malformed: { key: 'missing-type' }
    })).toEqual({
      anthropic: { type: 'api', key: 'api-key' },
      openai: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 }
    })
  })

  it('merges only the authenticated OpenCode MCP credential without overwriting newer Provider entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-test-'))
    const source = join(root, 'isolated', 'mcp-auth.json')
    const destination = join(root, 'provider-data', 'opencode', 'mcp-auth.json')
    try {
      await mkdir(join(root, 'isolated'), { recursive: true })
      await mkdir(join(root, 'provider-data', 'opencode'), { recursive: true })
      await writeFile(source, JSON.stringify({
        tracker: { accessToken: 'new-tracker-token' },
        other: { accessToken: 'stale-other-token' }
      }), { mode: 0o600 })
      await writeFile(destination, JSON.stringify({
        other: { accessToken: 'newer-provider-token' }
      }), { mode: 0o600 })
      await persistOpenCodeMcpAuth(source, destination, 'tracker')
      await expect(readFile(destination, 'utf8').then(JSON.parse)).resolves.toEqual({
        other: { accessToken: 'newer-provider-token' },
        tracker: { accessToken: 'new-tracker-token' }
      })
      expect((await stat(destination)).mode & 0o777).toBe(0o600)
      expect(openCodeMcpAuthFile({ HOME: '/provider-home' })).toBe(
        '/provider-home/.local/share/opencode/mcp-auth.json'
      )
      expect(openCodeMcpAuthFile({ HOME: '/provider-home', XDG_DATA_HOME: '/provider-data' })).toBe(
        '/provider-data/opencode/mcp-auth.json'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent OpenCode MCP credential persistence by destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-concurrent-'))
    const firstSource = join(root, 'first.json')
    const secondSource = join(root, 'second.json')
    const destination = join(root, 'provider-data', 'opencode', 'mcp-auth.json')
    try {
      await writeFile(firstSource, JSON.stringify({ first: { accessToken: 'first-token' } }), { mode: 0o600 })
      await writeFile(secondSource, JSON.stringify({ second: { accessToken: 'second-token' } }), { mode: 0o600 })
      await Promise.all([
        persistOpenCodeMcpAuth(firstSource, destination, 'first'),
        persistOpenCodeMcpAuth(secondSource, destination, 'second')
      ])
      await expect(readFile(destination, 'utf8').then(JSON.parse)).resolves.toEqual({
        first: { accessToken: 'first-token' },
        second: { accessToken: 'second-token' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('seeds isolated OpenCode auth from Provider state plus Scry-private overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-seed-'))
    const provider = join(root, 'provider.json')
    const managed = join(root, 'managed')
    const isolated = join(root, 'isolated.json')
    const tracker = {
      targetId: 'tracker-target', name: 'tracker', enabled: true,
      config: { type: 'http', url: 'https://first.example.test/mcp' }
    }
    const execution = { cwd: '/repo-a', fingerprint: 'sha256:first', env: {}, targets: [tracker] }
    try {
      await mkdir(managed, { recursive: true })
      await writeFile(provider, JSON.stringify({
        providerOnly: { accessToken: 'provider-token' },
        tracker: { accessToken: 'old-provider-token' }
      }), { mode: 0o600 })
      await writeFile(isolated, JSON.stringify({ tracker: { accessToken: 'scry-token' } }), { mode: 0o600 })
      await persistPrivateOpenCodeMcpAuth(isolated, managed, execution.cwd, tracker)
      expect((await stat(join(managed, `${openCodeMcpCredentialKey(execution.cwd, tracker)}.json`))).mode & 0o777).toBe(0o600)
      const seed = await openCodeMcpAuthSeed(provider, managed, execution)
      expect(seed && JSON.parse(seed.toString('utf8'))).toEqual({
        tracker: { accessToken: 'scry-token' }
      })
      const otherWorkspace = await openCodeMcpAuthSeed(provider, managed, {
        ...execution,
        cwd: '/repo-b',
        targets: [{ ...tracker, config: { type: 'http', url: 'https://second.example.test/mcp' } }]
      })
      expect(otherWorkspace).toBeNull()
      await expect(openCodeMcpAuthSeed(provider, managed, {
        ...execution,
        targets: [{ ...tracker, config: { type: 'http', url: 'https://changed.example.test/mcp' } }]
      })).resolves.toBeNull()
      await expect(stat(join(managed, `${openCodeMcpCredentialKey(execution.cwd, tracker)}.json`))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('seeds only the authenticated OpenCode target without pruning credentials omitted from a partial inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-partial-seed-'))
    const provider = join(root, 'provider.json')
    const managed = join(root, 'managed')
    const firstSource = join(root, 'first.json')
    const secondSource = join(root, 'second.json')
    const first = {
      targetId: 'first-target', name: 'first', enabled: true,
      config: { type: 'http', url: 'https://first.example.test/mcp' }
    }
    const second = {
      targetId: 'second-target', name: 'second', enabled: true,
      config: { type: 'http', url: 'https://second.example.test/mcp' }
    }
    const execution = { cwd: '/repo-a', fingerprint: 'sha256:all', env: {}, targets: [first, second] }
    const firstPath = join(managed, `${openCodeMcpCredentialKey(execution.cwd, first)}.json`)
    const secondPath = join(managed, `${openCodeMcpCredentialKey(execution.cwd, second)}.json`)
    try {
      await writeFile(firstSource, JSON.stringify({ first: { accessToken: 'first-token' } }), { mode: 0o600 })
      await writeFile(secondSource, JSON.stringify({ second: { accessToken: 'second-token' } }), { mode: 0o600 })
      await persistPrivateOpenCodeMcpAuth(firstSource, managed, execution.cwd, first)
      await persistPrivateOpenCodeMcpAuth(secondSource, managed, execution.cwd, second)

      const partialSeed = await openCodeMcpAuthSeed(provider, managed, {
        ...execution,
        fingerprint: 'sha256:auth:first-target',
        targets: [first]
      }, { completeTargetInventory: false })

      expect(partialSeed && JSON.parse(partialSeed.toString('utf8'))).toEqual({
        first: { accessToken: 'first-token' }
      })
      await expect(stat(firstPath)).resolves.toBeDefined()
      await expect(stat(secondPath)).resolves.toBeDefined()

      await expect(openCodeMcpAuthSeed(provider, managed, {
        ...execution,
        targets: [first]
      })).resolves.not.toBeNull()
      await expect(stat(firstPath)).resolves.toBeDefined()
      await expect(stat(secondPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates every inherited OpenCode and XDG control path while preserving ordinary provider credentials', () => {
    const env = isolatedOpenCodeChildEnv({
      HOME: '/outside/home',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'provider-key',
      OPENCODE_API_KEY: 'zen-key',
      OPENCODE_DB: '/outside/opencode.db',
      OPENCODE_WORKSPACE_ID: 'outside-workspace',
      OPENCODE_PLUGIN_META_FILE: '/outside/plugins.json',
      SCRY_OPENCODE_PROJECT_ROOT: '/outside/repo',
      XDG_DATA_HOME: '/outside/data',
      XDG_DATA_DIRS: '/outside/data-dirs'
    }, '/isolated', '/isolated/safe-config.json', '/isolated/config', '{"openai":{"type":"oauth"}}', 'random-password', '/persistent/opencode.db', '/canonical/repo')

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'provider-key',
      OPENCODE_API_KEY: 'zen-key',
      XDG_DATA_HOME: '/isolated/data',
      XDG_DATA_DIRS: '/isolated/data-dirs',
      XDG_RUNTIME_DIR: '/isolated/runtime',
      OPENCODE_DB: '/persistent/opencode.db',
      OPENCODE_CONFIG: '/isolated/safe-config.json',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth"}}',
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'random-password',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      SCRY_OPENCODE_PROJECT_ROOT: '/canonical/repo',
      HOME: '/isolated'
    })
    expect(env).not.toHaveProperty('OPENCODE_WORKSPACE_ID')
    expect(env).not.toHaveProperty('OPENCODE_PLUGIN_META_FILE')
    expect(openCodeServerAuthorization('random-password')).toBe(
      `Basic ${Buffer.from('opencode:random-password').toString('base64')}`
    )
  })

  it('keeps the OpenCode session database stable per canonical workspace with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-session-db-'))
    const stateRoot = join(root, 'provider-state', 'opencode-v1')
    const repo = join(root, 'repo')
    const otherRepo = join(root, 'other-repo')
    const repoAlias = join(root, 'repo-alias')
    try {
      await mkdir(repo)
      await mkdir(otherRepo)
      await symlink(repo, repoAlias)

      const database = await openCodeSessionDatabase(stateRoot, repo)
      await writeFile(database, 'persistent-session-state')
      const resumedDatabase = await openCodeSessionDatabase(stateRoot, repoAlias)
      const otherDatabase = await openCodeSessionDatabase(stateRoot, otherRepo)

      expect(resumedDatabase).toBe(database)
      expect(otherDatabase).not.toBe(database)
      expect(await readFile(resumedDatabase, 'utf8')).toBe('persistent-session-state')
      expect((await stat(stateRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(dirname(database))).mode & 0o777).toBe(0o700)
      expect((await stat(database)).mode & 0o777).toBe(0o600)
      expect(dirname(database)).toMatch(/[a-f0-9]{64}$/)

      const outsideDatabase = join(root, 'outside.db')
      await writeFile(outsideDatabase, 'untrusted')
      await rm(database)
      await symlink(outsideDatabase, database)
      await expect(openCodeSessionDatabase(stateRoot, repo)).rejects.toThrow(/符号链接|symlink/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects canonical project plugins but only merges approved Scry-owned snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-project-config-'))
    const repo = join(root, 'repo')
    const skillRoot = join(repo, '.opencode', 'skills')
    const skill = join(skillRoot, 'scry-e2e-audit', 'SKILL.md')
    const plugin = join(repo, '.opencode', 'plugins', 'scry-e2e-hooks.js')
    const observer = join(root, 'run-owned', 'scry-hook-observer.mjs')
    try {
      await mkdir(join(skillRoot, 'scry-e2e-audit'), { recursive: true })
      await mkdir(join(repo, '.opencode', 'plugins'), { recursive: true })
      await writeFile(join(repo, 'AGENTS.md'), '# project instructions\n')
      await writeFile(join(repo, 'CLAUDE.md'), '# more project instructions\n')
      await writeFile(skill, '---\nname: scry-e2e-audit\ndescription: fixture\n---\n')
      await writeFile(plugin, 'export const Fixture = async () => ({})\n')
      await mkdir(join(root, '.config', 'opencode'), { recursive: true })
      await writeFile(join(root, 'opencode.json'), JSON.stringify({ plugin: ['ancestor-package'] }))
      await writeFile(join(root, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['user-package'] }))
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({
        instructions: ['AGENTS.md', 'CLAUDE.md'],
        plugin: ['./.opencode/plugins/scry-e2e-hooks.js'],
        permission: { '*': 'allow' },
        provider: { forbidden: { npm: '@untrusted/provider' } },
        mcp: { forbidden: { type: 'local', command: ['/bin/false'] } }
      }))

      const projection = await readOpenCodeProjectProjection(repo)
      const config = openCodeSafeConfig(undefined, projection, observer)
      const canonicalRepo = await realpath(repo)
      const canonicalSkillRoot = await realpath(skillRoot)
      const canonicalPlugin = await realpath(plugin)

      expect(projection).toMatchObject({
        cwd: canonicalRepo,
        instructions: [join(canonicalRepo, 'AGENTS.md'), join(canonicalRepo, 'CLAUDE.md')],
        skillRoot: canonicalSkillRoot,
        plugins: [{
          path: canonicalPlugin,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          size: expect.any(Number),
          contents: expect.any(Buffer)
        }],
        pluginFingerprint: expect.stringMatching(/^sha256:/),
        fingerprint: expect.stringMatching(/^sha256:/),
        contentFingerprint: expect.stringMatching(/^sha256:/)
      })
      expect(config).toEqual({
        mcp: {},
        instructions: [join(canonicalRepo, 'AGENTS.md'), join(canonicalRepo, 'CLAUDE.md')],
        skills: { paths: [canonicalSkillRoot] },
        plugin: [pathToFileURL(observer).href]
      })
      expect(config.plugin).not.toContain(pathToFileURL(canonicalPlugin).href)
      expect(config).not.toHaveProperty('permission')
      expect(config).not.toHaveProperty('provider')
      await expect(assertOpenCodeProjectProjection(projection)).resolves.toBeUndefined()

      await mkdir(join(root, 'run-owned'))
      const snapshots = await writeOpenCodePluginSnapshots(join(root, 'run-owned'), projection, {
        cwd: projection.cwd,
        fingerprint: projection.pluginFingerprint,
        plugins: projection.plugins
      })
      const trustedConfig = openCodeSafeConfig(undefined, projection, observer, snapshots)
      expect(trustedConfig.plugin).toEqual([
        pathToFileURL(observer).href,
        pathToFileURL(snapshots[0]!).href
      ])
      expect(snapshots[0]).not.toBe(canonicalPlugin)
      expect(await readFile(snapshots[0]!, 'utf8')).toBe(await readFile(canonicalPlugin, 'utf8'))
      expect((await stat(snapshots[0]!)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reuses an OpenCode server only while projected instruction and Skill contents stay unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-project-reuse-'))
    const repo = join(root, 'repo')
    const instruction = join(repo, 'AGENTS.md')
    try {
      await mkdir(repo)
      await writeFile(instruction, '# original\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ instructions: ['AGENTS.md'] }))
      const projection = await readOpenCodeProjectProjection(repo)
      const process = { exitCode: null, killed: true }
      const dispatcher = { destroy: vi.fn() } as unknown as Dispatcher
      const active = {
        cwd: projection.cwd,
        mcpFingerprint: 'none',
        projectFingerprint: projection.fingerprint,
        projectContentFingerprint: projection.contentFingerprint,
        projectPluginFingerprint: 'none',
        url: 'http://127.0.0.1:12345',
        client: {} as OpencodeClient,
        process,
        dispatcher,
        mcpAuthFile: ''
      }
      const manager = new OpenCodeServerManager(() => '/bin/opencode')
      const internals = manager as unknown as {
        active: typeof active | null
        start: (projection: OpenCodeProjectProjection, generation: number) => Promise<OpenCodeServerState>
      }
      internals.active = active
      const replacement: OpenCodeServerState = {
        cwd: projection.cwd,
        mcpFingerprint: 'none',
        projectFingerprint: projection.fingerprint,
        projectContentFingerprint: 'replacement',
        projectPluginFingerprint: 'none',
        url: 'http://127.0.0.1:54321',
        client: {} as OpencodeClient
      }
      const start = vi.spyOn(internals, 'start').mockResolvedValue(replacement)

      await expect(manager.ensure(repo)).resolves.toBe(active)
      expect(start).not.toHaveBeenCalled()

      await writeFile(instruction, '# changed\n')
      const changed = await readOpenCodeProjectProjection(repo)
      expect(changed.fingerprint).toBe(projection.fingerprint)
      expect(changed.contentFingerprint).not.toBe(projection.contentFingerprint)
      await expect(manager.ensure(repo)).resolves.toBe(replacement)
      expect(start).toHaveBeenCalledOnce()
      expect(start.mock.calls[0]?.[0].contentFingerprint).toBe(changed.contentFingerprint)
      expect(dispatcher.destroy).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not reuse active or starting OpenCode servers across plugin authorization fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-project-plugin-cache-'))
    const repo = join(root, 'repo')
    try {
      await mkdir(repo)
      await writeFile(join(repo, 'plugin.js'), 'export const Fixture = async () => ({})\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin.js'] }))
      const projection = await readOpenCodeProjectProjection(repo)
      const authorization = {
        cwd: projection.cwd,
        fingerprint: projection.pluginFingerprint,
        plugins: projection.plugins
      }
      const process = { exitCode: null, killed: true }
      const dispatcher = { destroy: vi.fn() } as unknown as Dispatcher
      const active = {
        cwd: projection.cwd,
        mcpFingerprint: 'none',
        projectFingerprint: projection.fingerprint,
        projectContentFingerprint: projection.contentFingerprint,
        projectPluginFingerprint: 'none',
        url: 'http://127.0.0.1:12345',
        client: {} as OpencodeClient,
        process,
        dispatcher,
        mcpAuthFile: ''
      }
      const manager = new OpenCodeServerManager(() => '/bin/opencode')
      const internals = manager as unknown as {
        active: typeof active | null
        starting: Promise<OpenCodeServerState> | null
        start: (
          projection: OpenCodeProjectProjection,
          generation: number,
          mcpExecution?: unknown,
          pluginTrust?: unknown
        ) => Promise<OpenCodeServerState>
      }
      const approved: OpenCodeServerState = {
        cwd: projection.cwd,
        mcpFingerprint: 'none',
        projectFingerprint: projection.fingerprint,
        projectContentFingerprint: projection.contentFingerprint,
        projectPluginFingerprint: projection.pluginFingerprint,
        url: 'http://127.0.0.1:54321',
        client: {} as OpencodeClient
      }
      const start = vi.spyOn(internals, 'start').mockResolvedValue(approved)

      internals.active = active
      await expect(manager.ensure(repo, undefined, authorization)).resolves.toBe(approved)
      expect(start).toHaveBeenCalledOnce()

      start.mockClear()
      internals.active = null
      internals.starting = Promise.resolve({ ...approved, projectPluginFingerprint: 'none' })
      await expect(manager.ensure(repo, undefined, authorization)).resolves.toBe(approved)
      expect(start).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates project plugin content and fails closed on unsafe plugin/instruction/Skill paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-project-config-deny-'))
    const repo = join(root, 'repo')
    const instruction = join(repo, 'AGENTS.md')
    const outside = join(root, 'outside.md')
    try {
      await mkdir(repo, { recursive: true })
      await writeFile(instruction, '# original\n')
      await writeFile(outside, '# outside\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({
        instructions: ['AGENTS.md'],
        plugin: []
      }))
      const projection = await readOpenCodeProjectProjection(repo)

      await writeFile(join(repo, 'opencode.json'), JSON.stringify({
        instructions: ['AGENTS.md'],
        plugin: ['untrusted-package']
      }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/本地相对|URL|package|逃逸/i)

      await writeFile(join(repo, 'opencode.json'), JSON.stringify({
        instructions: ['AGENTS.md'],
        plugin: ['../outside.js']
      }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/本地相对|URL|package|逃逸/i)

      await writeFile(join(repo, 'opencode.json'), JSON.stringify({
        instructions: ['AGENTS.md'],
        plugin: [['./plugin.js', { arbitrary: true }]]
      }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/本地相对|普通文件/i)

      await writeFile(join(repo, 'plugin.txt'), 'export const plugin = 1\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin.txt'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/\.js|\.mjs/i)

      await mkdir(join(repo, 'plugin-dir'))
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin-dir'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/普通文件/i)

      if (process.platform !== 'win32') {
        const fifo = join(repo, 'plugin-fifo.js')
        const mkfifo = spawnSync('/usr/bin/mkfifo', [fifo])
        expect(mkfifo.status).toBe(0)
        await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin-fifo.js'] }))
        await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/普通文件/i)
      }

      const outsidePlugin = join(root, 'outside-plugin.js')
      await writeFile(outsidePlugin, 'export const plugin = 1\n')
      await symlink(outsidePlugin, join(repo, 'linked-plugin.js'))
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./linked-plugin.js'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/符号链接|symlink/i)

      await writeFile(join(repo, 'large-plugin.js'), Buffer.alloc(4_000_001, 0x20))
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./large-plugin.js'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/过大|超限/i)

      await writeFile(join(repo, 'dependency.js'), 'export const dependency = 1\n')
      await writeFile(join(repo, 'plugin.js'), 'export { dependency } from "./dependency.js"\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin.js'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/单文件|相对 import|export/i)

      await writeFile(instruction, '# mutated\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ instructions: ['AGENTS.md'] }))
      const mutated = await readOpenCodeProjectProjection(repo)
      expect(mutated.fingerprint).toBe(projection.fingerprint)
      expect(mutated.contentFingerprint).not.toBe(projection.contentFingerprint)
      await expect(assertOpenCodeProjectProjection(projection)).rejects.toThrow(/变化|hash|fingerprint/i)

      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ instructions: ['../outside.md'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/项目目录|逃逸|可信/i)

      await rm(instruction)
      await symlink(outside, instruction)
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ instructions: ['AGENTS.md'] }))
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/符号链接|symlink/i)

      await rm(instruction)
      await writeFile(instruction, '# safe\n')
      const plugin = join(repo, 'plugin.js')
      await writeFile(plugin, 'export const plugin = 1\n')
      await writeFile(join(repo, 'opencode.json'), JSON.stringify({ plugin: ['./plugin.js'] }))
      const trusted = await readOpenCodeProjectProjection(repo)
      await writeFile(plugin, 'export const plugin = 2\n')
      const changedPlugin = await readOpenCodeProjectProjection(repo)
      expect(changedPlugin.pluginFingerprint).not.toBe(trusted.pluginFingerprint)
      await expect(writeOpenCodePluginSnapshots(join(root, 'stale-snapshot'), changedPlugin, {
        cwd: trusted.cwd,
        fingerprint: trusted.pluginFingerprint,
        plugins: trusted.plugins
      })).rejects.toThrow(/授权|fingerprint|不匹配/i)

      await mkdir(join(repo, '.opencode', 'skills'), { recursive: true })
      await symlink(join(root, 'outside-skills'), join(repo, '.opencode', 'skills', 'escaped'))
      await mkdir(join(root, 'outside-skills'), { recursive: true })
      await expect(readOpenCodeProjectProjection(repo)).rejects.toThrow(/符号链接|symlink/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('classifies native Skill scope from canonical project and home locations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-skill-scope-'))
    const home = join(root, 'home')
    const repo = join(home, 'repo')
    const projectSkill = join(repo, '.opencode', 'skills', 'project', 'SKILL.md')
    const userSkill = join(home, '.config', 'opencode', 'skills', 'user', 'SKILL.md')
    const outsideSkill = join(root, 'outside', 'SKILL.md')
    const escapedSkill = join(repo, '.opencode', 'skills', 'escaped', 'SKILL.md')
    try {
      await mkdir(join(repo, '.opencode', 'skills', 'project'), { recursive: true })
      await mkdir(join(home, '.config', 'opencode', 'skills', 'user'), { recursive: true })
      await mkdir(join(root, 'outside'), { recursive: true })
      await mkdir(join(repo, '.opencode', 'skills', 'escaped'), { recursive: true })
      await writeFile(projectSkill, '# project\n')
      await writeFile(userSkill, '# user\n')
      await writeFile(outsideSkill, '# outside\n')
      await symlink(outsideSkill, escapedSkill)

      await expect(openCodeSkillScope(repo, projectSkill, home)).resolves.toBe('project')
      await expect(openCodeSkillScope(repo, userSkill, home)).resolves.toBe('user')
      await expect(openCodeSkillScope(repo, outsideSkill, home)).resolves.toBe('unknown')
      await expect(openCodeSkillScope(repo, escapedSkill, home)).resolves.toBe('unknown')
      await expect(openCodeSkillScope(repo, '<built-in>', home)).resolves.toBe('unknown')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records authoritative OpenCode plugin hooks independently from the fixture marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-hook-observer-'))
    const trace = join(root, 'hook-trace.jsonl')
    const observer = join(root, 'observer.mjs')
    try {
      const source = openCodeHookObserverSource(trace)
      expect(source).not.toContain('.scry-e2e')
      expect(source).not.toContain('hook-events.jsonl')
      await writeFile(observer, source, { mode: 0o600 })
      const module = await import(`${pathToFileURL(observer).href}?test=${Date.now()}`)
      const hooks = await module.ScryHookObserver()
      await hooks['tool.execute.before']({ tool: 'read', sessionID: 'session-1', callID: 'call-1' })
      await hooks['tool.execute.after']({ tool: 'read', sessionID: 'session-1', callID: 'call-1' }, {})

      expect(await openCodeHookTraceCursor(trace)).toBeGreaterThan(0)
      expect((await stat(trace)).isFile()).toBe(true)
      const records = await readOpenCodeHookTrace(trace, 0)
      expect(records).toEqual([
        expect.objectContaining({ version: 1, stage: 'hook_started', sessionId: 'session-1', callId: 'call-1', tool: 'read', recordSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
        expect.objectContaining({ version: 1, stage: 'hook_response', sessionId: 'session-1', callId: 'call-1', tool: 'read', recordSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
      ])
      const lines = (await readFile(trace, 'utf8')).trimEnd().split('\n')
      expect(records.map((record) => record.recordSha256)).toEqual(
        lines.map((line) => `sha256:${createHash('sha256').update(`${line}\n`).digest('hex')}`)
      )
      await chmod(trace, 0o700)
      await expect(openCodeHookTraceCursor(trace)).rejects.toThrow(/私有普通文件/)
      await chmod(trace, 0o600)
      const alias = join(root, 'hook-trace-alias.jsonl')
      await symlink(trace, alias)
      await expect(openCodeHookTraceCursor(alias)).rejects.toThrow(/普通文件|可信/)
      const publicTrace = join(root, 'public-trace.jsonl')
      await writeFile(publicTrace, '', { mode: 0o644 })
      await expect(openCodeHookTraceCursor(publicTrace)).rejects.toThrow(/私有普通文件/)
      const oversized = join(root, 'oversized-trace.jsonl')
      await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), { mode: 0o600 })
      await expect(readOpenCodeHookTrace(oversized, 0)).rejects.toThrow(/4 MiB/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits only paired native OpenCode hook records for the exact session', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-hooks', prompt: 'inspect', cwd: '/repo', attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const records = [
      { version: 1 as const, stage: 'hook_started' as const, sessionId: 'session-1', callId: 'call-1', tool: 'read', timestamp: '2026-08-09T00:00:00.000Z', recordSha256: `sha256:${'1'.repeat(64)}` },
      { version: 1 as const, stage: 'hook_response' as const, sessionId: 'other-session', callId: 'call-1', tool: 'read', timestamp: '2026-08-09T00:00:00.001Z', recordSha256: `sha256:${'2'.repeat(64)}` },
      { version: 1 as const, stage: 'hook_response' as const, sessionId: 'session-1', callId: 'orphan', tool: 'write', timestamp: '2026-08-09T00:00:00.002Z', recordSha256: `sha256:${'3'.repeat(64)}` },
      { version: 1 as const, stage: 'hook_response' as const, sessionId: 'session-1', callId: 'call-1', tool: 'read', timestamp: '2026-08-09T00:00:00.003Z', recordSha256: `sha256:${'4'.repeat(64)}` }
    ]

    emitOpenCodeHookEvents(request, records, 'session-1', '/run-owned/hook-trace.jsonl')

    expect(events).toEqual([
      expect.objectContaining({ kind: 'hook', stage: 'hook_started', hookId: 'opencode:session-1:call-1', hookEvent: 'ToolExecute', hookOutcome: 'started', toolUseId: 'call-1' }),
      expect.objectContaining({ kind: 'hook', stage: 'hook_response', hookId: 'opencode:session-1:call-1', hookEvent: 'ToolExecute', hookOutcome: 'success', toolUseId: 'call-1' })
    ])
    expect(events[1]).not.toHaveProperty('hookExitCode')
    expect(events.every((event) => event.runtimeMetadata?.source === 'opencode_native_plugin_hook')).toBe(true)
    expect(events.every((event) => event.runtimeMetadata?.sourceTracePath === '/run-owned/hook-trace.jsonl')).toBe(true)
    expect(events.every((event) => event.runtimeMetadata?.sourceRecordHashBasis === 'jsonl_utf8_with_lf')).toBe(true)
    expect(events.map((event) => event.runtimeMetadata?.nativeHookEvent)).toEqual([
      'tool.execute.before',
      'tool.execute.after'
    ])
    expect(events.map((event) => event.runtimeMetadata?.sourceRecordSha256)).toEqual([
      `sha256:${'1'.repeat(64)}`,
      `sha256:${'4'.repeat(64)}`
    ])
  })

  it('drops incomplete, reversed, and tool-mismatched OpenCode hook lifecycles', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-invalid-hooks', prompt: 'inspect', cwd: '/repo', attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const record = (
      stage: 'hook_started' | 'hook_response',
      callId: string,
      tool: string,
      index: number
    ) => ({
      version: 1 as const, stage, sessionId: 'session-1', callId, tool,
      timestamp: `2026-08-09T00:00:00.00${index}Z`, recordSha256: `sha256:${String(index).repeat(64)}`
    })

    emitOpenCodeHookEvents(request, [
      record('hook_started', 'start-only', 'read', 1),
      record('hook_response', 'reversed', 'read', 2),
      record('hook_started', 'reversed', 'read', 3),
      record('hook_started', 'mismatch', 'read', 4),
      record('hook_response', 'mismatch', 'write', 5),
      record('hook_started', 'ambiguous', 'read', 6),
      record('hook_response', 'ambiguous', 'read', 7),
      record('hook_started', 'ambiguous', 'read', 8)
    ], 'session-1', '/run-owned/hook-trace.jsonl')

    expect(events).toEqual([])
  })

  it('returns canonical project, user, and unknown scopes from native Skill metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-skill-list-'))
    const home = join(root, 'home')
    const repo = join(home, 'repo')
    const projectSkill = join(repo, '.opencode', 'skills', 'project', 'SKILL.md')
    const userSkill = join(home, '.config', 'opencode', 'skills', 'user', 'SKILL.md')
    const outsideSkill = join(root, 'outside', 'SKILL.md')
    await Promise.all([
      mkdir(join(repo, '.opencode', 'skills', 'project'), { recursive: true }),
      mkdir(join(home, '.config', 'opencode', 'skills', 'user'), { recursive: true }),
      mkdir(join(root, 'outside'), { recursive: true })
    ])
    await Promise.all([
      writeFile(projectSkill, '# project\n'),
      writeFile(userSkill, '# user\n'),
      writeFile(outsideSkill, '# outside\n')
    ])
    const client = {
      v2: { skill: { list: vi.fn(async () => ({ data: { location: {}, data: [
        { name: 'project', location: projectSkill, description: 'project' },
        { name: 'user', location: userSkill, description: 'user' },
        { name: 'outside', location: outsideSkill, description: 'outside' }
      ] } })) } }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: repo, mcpFingerprint: 'none', url: 'http://127.0.0.1:12345', pid: 41, client
    })
    const adapter = createOpenCodeAdapter(home)
    try {
      const result = await adapter.skills!.list({ providerId: 'opencode', cwd: repo })
      expect(result.data).toEqual([
        expect.objectContaining({ name: 'project', scope: 'project', dir: projectSkill }),
        expect.objectContaining({ name: 'user', scope: 'user', dir: userSkill }),
        expect.objectContaining({ name: 'outside', scope: 'unknown', dir: outsideSkill })
      ])
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disables Undici header/body timeouts only for synchronous long-running session requests', async () => {
    const dispatcher = {} as Dispatcher
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof globalThis.fetch
    const openCodeFetch = createOpenCodeFetch(dispatcher, fetchImpl)

    await openCodeFetch(new Request('http://127.0.0.1:12345/session/ses-1/command', { method: 'POST' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({ dispatcher })
    )

    await openCodeFetch(new Request('http://127.0.0.1:12345/session/ses-1/message', { method: 'POST' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({ dispatcher })
    )

    await openCodeFetch(new Request('http://127.0.0.1:12345/session', { method: 'GET' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.any(Request), undefined)
    expect(OPEN_CODE_LONG_REQUEST_TIMEOUTS).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
  })

  it('redacts credentials from bounded OpenCode server diagnostics', () => {
    const log = sanitizeOpenCodeServerLog([
      'Authorization: Basic dXNlcjpzZWNyZXQ=',
      'token=plain-token',
      'api_key: "provider-secret"',
      'OPENAI_API_KEY=sk-openai-secret',
      'ANTHROPIC_API_KEY=sk-ant-secret',
      'OPENCODE_SERVER_PASSWORD=server-secret',
      'GITHUB_TOKEN=github-secret',
      '"COOKIE": "session-secret"',
      'fatal: headers timeout'
    ].join('\n'))

    expect(log).toContain('fatal: headers timeout')
    expect(log).not.toContain('dXNlcjpzZWNyZXQ=')
    expect(log).not.toContain('plain-token')
    expect(log).not.toContain('provider-secret')
    expect(log).not.toContain('sk-openai-secret')
    expect(log).not.toContain('sk-ant-secret')
    expect(log).not.toContain('server-secret')
    expect(log).not.toContain('github-secret')
    expect(log).not.toContain('session-secret')
  })

  it('exposes native server capabilities without claiming account billing support', async () => {
    await expect(createOpenCodeAdapter().describe()).resolves.toMatchObject({
      id: 'opencode',
      runtimeProvider: 'opencode_server',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('does not degrade Provider health when an unbound session requests workspace metadata', async () => {
    const adapter = createOpenCodeAdapter()
    try {
      await expect(adapter.runControls!.read({ providerId: 'opencode' })).resolves.toMatchObject({
        state: 'degraded',
        reason: 'OpenCode 需要工作目录'
      })
      await expect(adapter.describe()).resolves.toMatchObject({ health: { state: 'unknown' } })
    } finally {
      adapter.dispose?.()
    }
  })

  it('reports invalid OpenCode project plugin authorization as a capability error with reauthorization action', async () => {
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockRejectedValue(
      new OpenCodeProjectPluginSecurityError('OpenCode 项目 plugin 授权已失效，拒绝启动')
    )
    const adapter = createOpenCodeAdapter()
    try {
      const handle = adapter.run({
        runId: 'run-invalid-plugin-trust',
        prompt: 'inspect',
        cwd: '/repo',
        attachments: [],
        emit: () => {}
      })
      await expect(handle.promise).rejects.toMatchObject({
        name: 'AgentRuntimeError',
        brief: {
          provider: 'opencode_server',
          stage: 'capability',
          cwd: '/repo',
          nextAction: expect.stringMatching(/重新.*授权|最新.*授权/)
        }
      })
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
    }
  })

  it('keeps MCP disabled until authorization and converts only approved configs into isolated OpenCode format', () => {
    expect(openCodeMcpConfig()).toEqual({})
    expect(openCodeMcpConfig({
      cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
      targets: [
        { targetId: 'local', name: 'local', enabled: true, config: { command: '/bin/echo', args: ['ok'], env: { SAFE: '1' } } },
        { targetId: 'off', name: 'off', enabled: false, config: { command: '/bin/off' } },
        { targetId: 'remote', name: 'remote', enabled: true, config: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'configured' }, oauth: false } }
      ]
    })).toEqual({
      local: { type: 'local', command: ['/bin/echo', 'ok'], environment: { PATH: '/bin', SAFE: '1' }, enabled: true },
      remote: { type: 'remote', url: 'https://mcp.example.test', headers: { Authorization: 'configured' }, oauth: false, enabled: true }
    })
  })

  it('lists OpenCode config without starting a server and reads native status only after authorization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-mcp-test-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'local', command: ['/bin/echo', 'configured'] } }
    }))
    const client = {
      mcp: { status: vi.fn(async () => ({ data: {
        tracker: { status: 'connected' },
        registration: { status: 'needs_client_registration' }
      } })) }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:test', url: 'http://127.0.0.1:12345', pid: 41, client
    })
    const adapter = createOpenCodeAdapter(home)
    try {
      await expect(adapter.mcp!.snapshot({ providerId: 'opencode', cwd: '/repo' })).resolves.toMatchObject({
        state: 'degraded', data: { configured: [expect.objectContaining({ name: 'tracker' })], runtime: null }
      })
      expect(ensure).not.toHaveBeenCalled()
      const execution = {
        cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
        targets: [{ targetId: 'tracker', name: 'tracker', enabled: true, config: { command: '/bin/echo', args: ['approved'] } }]
      }
      await expect(adapter.mcp!.snapshot({ providerId: 'opencode', cwd: '/repo' }, true, execution)).resolves.toMatchObject({
        state: 'ready', data: { runtime: [
          { name: 'tracker', status: 'connected' },
          { name: 'registration', status: 'needs-client-registration' }
        ] }
      })
      expect(ensure).toHaveBeenCalledWith('/repo', execution, undefined)
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('redacts credentials from native MCP refresh failures and Provider health', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-mcp-error-test-'))
    await mkdir(join(home, '.config', 'opencode'), { recursive: true })
    await writeFile(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
      mcp: { remote: { type: 'remote', url: 'https://mcp.example.test' } }
    }))
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure')
      .mockRejectedValue(new Error('refreshToken=secret-refresh'))
    const adapter = createOpenCodeAdapter(home)
    try {
      const result = await adapter.mcp!.snapshot(
        { providerId: 'opencode', cwd: '/repo' },
        true,
        {
          cwd: '/repo', fingerprint: 'sha256:test', env: {},
          targets: [{ targetId: 'remote', name: 'remote', enabled: true, config: { url: 'https://mcp.example.test' } }]
        }
      )

      expect(result.reason).toContain('[redacted]')
      expect(result.reason).not.toContain('secret-refresh')
      const health = (await adapter.describe()).health
      expect(health?.lastError).toContain('[redacted]')
      expect(health?.lastError).not.toContain('secret-refresh')
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('authenticates one exact remote MCP, persists Provider credentials, reconnects, and verifies status', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-flow-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'remote', url: 'https://mcp.example.test' } }
    }))
    const authenticate = vi.fn(async () => ({ data: true }))
    const connect = vi.fn(async () => ({ data: true }))
    const status = vi.fn(async () => ({ data: { tracker: { status: 'connected' } } }))
    const client = { mcp: { auth: { authenticate }, connect, status } } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:auth', url: 'http://127.0.0.1:12345', pid: 44, client
    })
    const persist = vi.spyOn(OpenCodeServerManager.prototype, 'persistMcpAuth').mockResolvedValue()
    const adapter = createOpenCodeAdapter(home)
    const execution = {
      cwd: '/repo',
      fingerprint: 'sha256:auth',
      env: {},
      targets: [
        {
          targetId: 'tracker-target',
          name: 'tracker',
          enabled: true,
          config: { type: 'http', url: 'https://mcp.example.test' }
        },
        {
          targetId: 'unrelated-target',
          name: 'unrelated',
          enabled: true,
          config: { type: 'http', url: 'https://unrelated.example.test' }
        }
      ]
    }
    try {
      await expect(adapter.mcp!.snapshot(
        { providerId: 'opencode', cwd: '/repo' },
        true,
        execution
      )).resolves.toMatchObject({
        data: { operations: { authenticate: ['tracker-target', 'unrelated-target'] } }
      })
      await expect(adapter.mcp!.reauthenticate?.(
        { providerId: 'opencode', cwd: '/repo' },
        'tracker-target',
        execution,
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )).resolves.toMatchObject({
        state: 'ready',
        data: { ok: true, status: 'authenticated' }
      })
      expect(authenticate).toHaveBeenCalledWith({ name: 'tracker', directory: '/repo' })
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        targetId: 'tracker-target', name: 'tracker'
      }), '/repo')
      expect(connect).toHaveBeenCalledWith({ name: 'tracker', directory: '/repo' })
      expect(ensure).toHaveBeenLastCalledWith('/repo', expect.objectContaining({
        targets: [expect.objectContaining({ targetId: 'tracker-target' })]
      }))
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      persist.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports durable OpenCode credentials separately from a failed reconnect', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-unverified-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'remote', url: 'https://mcp.example.test' } }
    }))
    const client = {
      mcp: {
        auth: { authenticate: vi.fn(async () => ({ data: true })) },
        connect: vi.fn(async () => { throw new Error('connect unavailable') })
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:auth', url: 'http://127.0.0.1:12345', pid: 44, client
    })
    const persist = vi.spyOn(OpenCodeServerManager.prototype, 'persistMcpAuth').mockResolvedValue()
    const adapter = createOpenCodeAdapter(home)
    try {
      await expect(adapter.mcp!.reauthenticate!(
        { providerId: 'opencode', cwd: '/repo' },
        'tracker-target',
        {
          cwd: '/repo', fingerprint: 'sha256:auth', env: {},
          targets: [{
            targetId: 'tracker-target', name: 'tracker', enabled: true,
            config: { type: 'http', url: 'https://mcp.example.test' }
          }]
        },
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )).resolves.toMatchObject({
        data: {
          ok: false,
          status: 'authenticated-unverified',
          error: expect.stringContaining('connect unavailable')
        }
      })
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        targetId: 'tracker-target', name: 'tracker'
      }), '/repo')
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      persist.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('times out OpenCode browser authentication and closes the isolated server before credentials can persist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-auth-timeout-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'remote', url: 'https://mcp.example.test' } }
    }))
    const authenticate = vi.fn(() => new Promise(() => {}))
    const client = { mcp: { auth: { authenticate } } } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:auth', url: 'http://127.0.0.1:12345', pid: 44, client
    })
    const persist = vi.spyOn(OpenCodeServerManager.prototype, 'persistMcpAuth').mockResolvedValue()
    const close = vi.spyOn(OpenCodeServerManager.prototype, 'close').mockImplementation(() => {})
    const adapter = createOpenCodeAdapter(home)
    const execution = {
      cwd: '/repo', fingerprint: 'sha256:auth', env: {},
      targets: [{
        targetId: 'tracker-target', name: 'tracker', enabled: true,
        config: { type: 'http', url: 'https://mcp.example.test' }
      }]
    }
    vi.useFakeTimers()
    try {
      const result = adapter.mcp!.reauthenticate!(
        { providerId: 'opencode', cwd: '/repo' },
        'tracker-target',
        execution,
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )
      await vi.advanceTimersByTimeAsync(120_000)
      await expect(result).resolves.toMatchObject({
        state: 'ready', data: { ok: false, status: 'failed', error: expect.stringContaining('超时') }
      })
      expect(close).toHaveBeenCalledOnce()
      expect(persist).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      adapter.dispose?.()
      ensure.mockRestore()
      persist.mockRestore()
      close.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps persisted OpenCode credentials when reconnect verification times out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-verify-timeout-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'remote', url: 'https://mcp.example.test' } }
    }))
    const client = {
      mcp: {
        auth: { authenticate: vi.fn(async () => ({ data: true })) },
        connect: vi.fn(() => new Promise(() => {}))
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:auth', url: 'http://127.0.0.1:12345', pid: 44, client
    })
    const persist = vi.spyOn(OpenCodeServerManager.prototype, 'persistMcpAuth').mockResolvedValue()
    const close = vi.spyOn(OpenCodeServerManager.prototype, 'close').mockImplementation(() => {})
    const adapter = createOpenCodeAdapter(home)
    vi.useFakeTimers()
    try {
      const result = adapter.mcp!.reauthenticate!(
        { providerId: 'opencode', cwd: '/repo' },
        'tracker-target',
        {
          cwd: '/repo', fingerprint: 'sha256:auth', env: {},
          targets: [{
            targetId: 'tracker-target', name: 'tracker', enabled: true,
            config: { type: 'http', url: 'https://mcp.example.test' }
          }]
        },
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(result).resolves.toMatchObject({
        data: {
          ok: false,
          status: 'authenticated-unverified',
          error: expect.stringContaining('状态校验超时')
        }
      })
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        targetId: 'tracker-target', name: 'tracker'
      }), '/repo')
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      adapter.dispose?.()
      ensure.mockRestore()
      persist.mockRestore()
      close.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('maps native models and excludes the unsupported auto-review mode', () => {
    expect(openCodeRunControlCatalog([{
      id: 'claude-sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      request: { variant: 'high' },
      variants: [{ id: 'low' }, { id: 'high' }]
    }])).toEqual({
      models: [{
        model: { id: 'claude-sonnet', providerId: 'anthropic' },
        label: 'Claude Sonnet · anthropic',
        efforts: [
          { id: 'low', label: '低' },
          { id: 'high', label: '高', isDefault: true }
        ]
      }],
      permissions: expect.not.arrayContaining([expect.objectContaining({ id: 'auto_review' })])
    })
    expect(openCodePermissionRules('default')).toEqual([{ permission: '*', pattern: '*', action: 'ask' }])
    expect(openCodePermissionRules('full_access')).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
    expect(() => openCodePermissionRules('auto_review')).toThrow('不支持自动审查')
  })

  it('translates a native permission request through the inline approval channel', async () => {
    const reply = vi.fn().mockResolvedValue({ data: true })
    const request = {
      runId: 'run-permission',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {},
      requestUserInput: vi.fn(async (question) => ({
        runId: question.runId,
        questionId: question.questionId,
        behavior: 'answered' as const,
        answers: { [question.questions[0].question]: '本次会话允许' }
      }))
    } satisfies ProviderRunRequest
    const client = { permission: { reply } } as unknown as OpencodeClient

    await expect(handleOpenCodePermission(request, client, {
      type: 'permission.asked',
      properties: {
        id: 'permission-1',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['npm test']
      }
    }, 'session-1')).resolves.toBe(true)

    expect(reply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: '/repo',
      reply: 'always'
    })
  })

  it('bridges native question.v2 choices and replies with ordered answer arrays', async () => {
    const reply = vi.fn().mockResolvedValue({ data: true })
    const request = {
      runId: 'run-question',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {},
      requestUserInput: vi.fn(async (question) => ({
        runId: question.runId,
        questionId: question.questionId,
        behavior: 'answered' as const,
        answers: {
          [question.questions[0].question]: '全量',
          [question.questions[1].question]: 'MCP, Skill'
        }
      }))
    } satisfies ProviderRunRequest
    const client = { v2: { session: { question: { reply, reject: vi.fn() } } } } as unknown as OpencodeClient

    await expect(handleOpenCodeQuestion(request, client, {
      type: 'question.v2.asked',
      properties: {
        id: 'question-1',
        sessionID: 'session-1',
        tool: { callID: 'call-question' },
        questions: [
          {
            header: '范围', question: '选择范围？', multiple: false,
            options: [{ label: '全量', description: '全部' }, { label: '增量', description: '变化' }]
          },
          {
            header: '能力', question: '选择能力？', multiple: true,
            options: [{ label: 'MCP', description: 'MCP' }, { label: 'Skill', description: 'Skill' }]
          }
        ]
      }
    }, 'session-1')).resolves.toBe(true)

    expect(request.requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'call-question',
        questionKind: 'clarification',
        source: 'opencode:question.v2.asked'
      }),
      expect.any(AbortSignal)
    )
    expect(reply).toHaveBeenCalledWith({
      sessionID: 'session-1',
      requestID: 'question-1',
      questionV2Reply: { answers: [['全量'], ['MCP', 'Skill']] }
    })
  })

  it('records current OpenCode message.part.updated tool lifecycle events', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-1',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const base = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          type: 'tool',
          callID: 'call-1',
          tool: 'read',
          state: { input: { filePath: '/repo/README.md' } }
        }
      }
    }

    emitOpenCodeEvent(request, {
      ...base,
      properties: { ...base.properties, part: { ...base.properties.part, state: { ...base.properties.part.state, status: 'running' } } }
    }, 'session-1')
    emitOpenCodeEvent(request, {
      ...base,
      properties: {
        ...base.properties,
        part: { ...base.properties.part, state: { ...base.properties.part.state, status: 'completed', output: 'ok' } }
      }
    }, 'session-1')

    expect(events).toEqual([
      expect.objectContaining({ kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'call-1', fileOp: 'read', filePath: '/repo/README.md' }),
      expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'call-1', output: 'ok', isError: false })
    ])
  })

  it('normalizes the native OpenCode Skill identity', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-2',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const part = {
      type: 'tool',
      callID: 'skill-1',
      tool: 'skill',
      state: { status: 'completed', input: { name: 'scry-e2e-audit' }, output: 'loaded' }
    }
    emitOpenCodeEvent(request, { type: 'message.part.updated', properties: { sessionID: 'session-2', part } }, 'session-2')

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', stage: 'skill:scry-e2e-audit', tool: 'Skill', name: 'scry-e2e-audit', toolUseId: 'skill-1' })
    ]))
  })

  it('records one completed OpenCode compaction and ignores duplicate delivery', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-compact',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const compacted = {
      id: 'event-compact',
      type: 'session.next.compaction.ended',
      properties: {
        timestamp: Date.parse('2026-08-07T00:00:00.000Z'),
        sessionID: 'session-compact',
        messageID: 'message-compact',
        reason: 'manual',
        text: 'summary',
        recent: ''
      }
    }

    emitOpenCodeEvent(request, compacted, 'session-compact')
    emitOpenCodeEvent(request, compacted, 'session-compact')

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'harness',
        stage: 'context_compaction',
        ts: '2026-08-07T00:00:00.000Z',
        compaction: { trigger: 'manual', providerEventId: 'message-compact' }
      })
    ])
  })

  it('保留 OpenCode shell bridge 的多 MCP 调用并识别业务失败', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-mcp-shell',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const part = {
      type: 'tool',
      callID: 'mcp-shell',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'mcporter call coop.query --args \'{}\' && mcporter call group-env.list --args \'{}\'' }
      }
    }
    emitOpenCodeEvent(
      request,
      { type: 'message.part.updated', properties: { sessionID: 'session-mcp-shell', part } },
      'session-mcp-shell'
    )
    emitOpenCodeEvent(
      request,
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-mcp-shell',
          part: {
            ...part,
            state: { ...part.state, status: 'completed', output: '{"success":false,"error":"denied"}' }
          }
        }
      },
      'session-mcp-shell'
    )
    expect(events[0]).toMatchObject({
      isMcp: true,
      mcpCalls: [
        { server: 'coop', action: 'query' },
        { server: 'group-env', action: 'list' }
      ]
    })
    expect(events[1]).toMatchObject({ stage: 'tool_result', isMcp: true, isError: true })
  })

  it('returns the native message id/timing and aborts the SSE subscription after a successful slash command', async () => {
    const hookRoot = await mkdtemp(join(tmpdir(), 'scry-opencode-run-hooks-'))
    const hookTracePath = join(hookRoot, 'hook-trace.jsonl')
    await writeFile(hookTracePath, '', { mode: 0o600 })
    const emitted: TraceEvent[] = []
    let subscriptionSignal: AbortSignal | undefined
    let retryDelaySettled = false
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        command: vi.fn(async () => {
          await appendFile(hookTracePath, [
            JSON.stringify({ version: 1, stage: 'hook_started', sessionId: 'session-1', callId: 'call-1', tool: 'read', timestamp: '2026-08-09T00:00:00.000Z' }),
            JSON.stringify({ version: 1, stage: 'hook_response', sessionId: 'session-1', callId: 'call-1', tool: 'read', timestamp: '2026-08-09T00:00:00.010Z' })
          ].join('\n') + '\n')
          return {
            data: {
              info: {
                id: 'message-1',
                time: { created: 1_000, completed: 4_000 },
                tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                providerID: 'anthropic',
                modelID: 'model-1',
                finish: 'length'
              },
              parts: []
            }
          }
        }),
        abort: vi.fn(async () => ({ data: true }))
      },
      event: {
        subscribe: vi.fn(async (_parameters, options) => {
          subscriptionSignal = options?.signal
          const retrySleep = (options as unknown as {
            sseSleepFn?: (delayMs: number) => Promise<void>
          })?.sseSleepFn
          if (!retrySleep) throw new Error('missing abort-aware SSE sleep')
          const retryDelay = retrySleep(30_000).then(() => {
            retryDelaySettled = true
          })
          return { stream: (async function * () { await retryDelay })() }
        })
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo',
      mcpFingerprint: 'none',
      url: 'http://127.0.0.1:12345',
      pid: 42,
      hookTracePath,
      client
    })
    const adapter = createOpenCodeAdapter()

    try {
      const handle = adapter.run({
        runId: 'run-success',
        prompt: '/rate-workflow 1',
        cwd: '/repo',
        attachments: [],
        permissionMode: 'full_access',
        emit: (event) => emitted.push(event)
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'session-1',
        providerTurnId: 'message-1',
        stopped: false
      })
      expect(handle.getProviderTurnId?.()).toBe('message-1')
      expect(subscriptionSignal?.aborted).toBe(true)
      expect(retryDelaySettled).toBe(true)
      expect(emitted.filter((event) => event.kind === 'hook')).toEqual([
        expect.objectContaining({
          stage: 'hook_started', hookId: 'opencode:session-1:call-1', hookOutcome: 'started',
          runtimeMetadata: expect.objectContaining({ sourceTracePath: hookTracePath, sourceRecordSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
        }),
        expect.objectContaining({
          stage: 'hook_response', hookId: 'opencode:session-1:call-1', hookOutcome: 'success',
          runtimeMetadata: expect.objectContaining({ sourceTracePath: hookTracePath, sourceRecordSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
        })
      ])
      expect(emitted.find((event) => event.stage === 'hook_response')).not.toHaveProperty('hookExitCode')
      expect(emitted.at(-1)).toMatchObject({
        kind: 'harness',
        stage: 'result',
        messageId: 'message-1',
        durationMs: 3_000,
        isError: false,
        providerStopReason: 'length',
        terminationReason: 'output_token_limit'
      })
      expect(emitted.at(-1)?.ts).toBe('1970-01-01T00:00:04.000Z')
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      await rm(hookRoot, { recursive: true, force: true })
    }
  })

  it('preserves the local transport cause and degrades provider health instead of reporting a generic network error', async () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-timeout' } })),
        command: vi.fn(async () => ({
          error: new TypeError('fetch failed', { cause }),
          request: new Request('http://127.0.0.1:12345/session/session-timeout/command', { method: 'POST' }),
          response: undefined
        })),
        abort: vi.fn(async () => ({ data: true }))
      },
      event: {
        subscribe: vi.fn(async () => ({ stream: (async function * () {})() }))
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo',
      mcpFingerprint: 'none',
      url: 'http://127.0.0.1:12345',
      pid: 43,
      client
    })
    const adapter = createOpenCodeAdapter()

    try {
      const handle = adapter.run({
        runId: 'run-timeout',
        prompt: '/rate-workflow 1',
        cwd: '/repo',
        attachments: [],
        permissionMode: 'full_access',
        emit: () => {}
      })

      await expect(handle.promise).rejects.toMatchObject({
        name: 'AgentRuntimeError',
        message: expect.stringContaining('UND_ERR_HEADERS_TIMEOUT'),
        brief: expect.objectContaining({
          provider: 'opencode_server',
          stage: 'protocol',
          commandSummary: 'session.command',
          transportCode: 'UND_ERR_HEADERS_TIMEOUT',
          requestMethod: 'POST',
          requestPath: '/session/{sessionId}/command'
        })
      })
      await expect(handle.promise).rejects.toHaveProperty(
        'cause.cause.cause.code',
        'UND_ERR_HEADERS_TIMEOUT'
      )
      expect(client.session.abort).toHaveBeenCalledWith({
        sessionID: 'session-timeout',
        directory: '/repo'
      })
      await expect(adapter.describe()).resolves.toMatchObject({
        health: {
          state: 'degraded',
          lastError: expect.stringContaining('UND_ERR_HEADERS_TIMEOUT')
        }
      })
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
    }
  })

})
