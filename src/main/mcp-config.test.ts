import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizedMcpRuntimeEnv,
  listMcp,
  mcpDisabledSet,
  minimalMcpEnv,
  resolveProviderMcpConfigs,
  testHttpMcp,
  testMcpConfig,
  toggleMcp
} from './mcp-config'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-mcp-'))

describe('mcp-config', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('only inherits the explicit MCP child environment allowlist', () => {
    expect(minimalMcpEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      LANG: 'zh_CN.UTF-8',
      TERM: 'xterm-256color',
      LC_ALL: 'zh_CN.UTF-8',
      HTTPS_PROXY: 'http://proxy',
      HTTP_PROXY: 'http://user:password@credential-proxy',
      ALL_PROXY: 'socks5://proxy.example.test:1080',
      all_proxy: 'user:password@credential-proxy:1080',
      OPENAI_ADMIN_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret-2'
    })).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      LANG: 'zh_CN.UTF-8',
      TERM: 'xterm-256color',
      LC_ALL: 'zh_CN.UTF-8',
      HTTPS_PROXY: 'http://proxy',
      ALL_PROXY: 'socks5://proxy.example.test:1080'
    })
  })

  it('preserves provider auth while replacing every MCP-managed parent environment key', () => {
    expect(authorizedMcpRuntimeEnv({
      PATH: '/runtime/bin',
      TERM: 'runtime-term',
      LANG: 'runtime-lang',
      LC_ALL: 'runtime-locale',
      HTTPS_PROXY: 'http://runtime-proxy',
      SSL_CERT_FILE: '/runtime/cert',
      ANTHROPIC_API_KEY: 'provider-auth',
      AWS_PROFILE: 'provider-profile'
    }, {
      PATH: '/approved/bin',
      TERM: 'approved-term',
      LANG: 'approved-lang',
      HTTPS_PROXY: 'http://approved-proxy',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
    })).toEqual({
      ANTHROPIC_API_KEY: 'provider-auth',
      AWS_PROFILE: 'provider-profile',
      PATH: '/approved/bin',
      TERM: 'approved-term',
      LANG: 'approved-lang',
      HTTPS_PROXY: 'http://approved-proxy',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
    })
  })

  it('requires a successful, structurally valid HTTP tools/list response', async () => {
    const run = async (tools: Response): Promise<Awaited<ReturnType<typeof testHttpMcp>>> => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(tools)
      vi.stubGlobal('fetch', fetch)
      return testHttpMcp({ url: 'https://mcp.example.test' })
    }

    await expect(run(new Response('denied', { status: 500 }))).resolves.toMatchObject({ ok: false, error: 'tools/list HTTP 500' })
    await expect(run(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }), { status: 200 }))).resolves.toMatchObject({ ok: false })
    await expect(run(new Response(JSON.stringify({ jsonrpc: '2.0', id: '2', result: { tools: [] } }), { status: 200 }))).resolves.toMatchObject({ ok: false })
    await expect(run(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] }, error: null }), { status: 200 }))).resolves.toMatchObject({ ok: false })
    await expect(run(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }), { status: 200 }))).resolves.toEqual({ ok: true, tools: 0, toolNames: [] })
  })

  it('rejects malformed stdio tools/list and executes it in the authorized cwd', async () => {
    const cwd = tempDir()
    const script = join(cwd, 'server.mjs')
    writeFileSync(script, `
      import readline from 'node:readline'
      const input = readline.createInterface({ input: process.stdin })
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
      input.on('line', (line) => {
        const message = JSON.parse(line)
        if (message.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} })
        if (message.id === 2) send({ jsonrpc: '2.0', id: 2, result: { cwd: process.cwd() } })
      })
    `)
    try {
      await expect(testMcpConfig({ command: process.execPath, args: [script] }, process.env, cwd)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('无效 JSON-RPC')
      })
      writeFileSync(script, `
        import readline from 'node:readline'
        const input = readline.createInterface({ input: process.stdin })
        const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
        input.on('line', (line) => {
          const message = JSON.parse(line)
          if (message.id === 1) send({ jsonrpc: '2.0', id: 1, result: {} })
          if (message.id === 2) send({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: process.cwd() }] } })
        })
      `)
      await expect(testMcpConfig({ command: process.execPath, args: [script] }, process.env, cwd)).resolves.toEqual({
        ok: true,
        tools: 1,
        toolNames: [realpathSync(cwd)]
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('enabledMcpjsonServers 覆盖 disabledMcpjsonServers', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          projects: {
            [cwd]: {
              disabledMcpjsonServers: ['tracker'],
              enabledMcpjsonServers: ['tracker'],
              disabledMcpServers: ['user-off']
            }
          }
        })
      )
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { tracker: { command: 'tracker' }, 'user-off': { command: 'x' } } })
      )

      expect([...mcpDisabledSet(cwd, home)]).toEqual(['user-off'])
      expect(listMcp(cwd, home)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'tracker', enabled: true }),
          expect.objectContaining({ name: 'user-off', enabled: false })
        ])
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('开关项目 MCP 后配置读取与 disabled/connected 状态一致，并可恢复', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ keep: 'value', projects: {} }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'scry-e2e': { command: '/bin/mcp' } } }))

      expect(toggleMcp('scry-e2e', false, cwd, home)).toBe(true)
      expect(listMcp(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e', enabled: false }))
      expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toMatchObject({
        keep: 'value',
        projects: {
          [cwd]: {
            disabledMcpjsonServers: ['scry-e2e'],
            enabledMcpjsonServers: [],
            disabledMcpServers: ['scry-e2e']
          }
        }
      })

      expect(toggleMcp('scry-e2e', true, cwd, home)).toBe(true)
      expect(listMcp(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e', enabled: true }))
      expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toMatchObject({
        keep: 'value',
        projects: {
          [cwd]: {
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: ['scry-e2e'],
            disabledMcpServers: []
          }
        }
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('显式关闭不会被项目已有的 MCP 信任标记重新启用', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'scry-e2e': { command: '/bin/mcp' } } }))
      writeFileSync(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ enabledMcpjsonServers: ['scry-e2e'] })
      )

      expect(toggleMcp('scry-e2e', false, cwd, home)).toBe(true)
      expect(listMcp(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e', enabled: false }))

      expect(toggleMcp('scry-e2e', true, cwd, home)).toBe(true)
      expect(listMcp(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e', enabled: true }))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('normalizes Codex, Qoder, and OpenCode native MCP configs without reading unrelated files', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      mkdirSync(join(home, '.codex'), { recursive: true })
      mkdirSync(join(home, '.qoder'), { recursive: true })
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      mkdirSync(join(cwd, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.codex-user]\ncommand = "/bin/echo"\nargs = ["user"]\n')
      writeFileSync(join(cwd, '.codex', 'config.toml'), '[mcp_servers.codex-project]\nurl = "https://mcp.example.test"\n')
      writeFileSync(join(home, '.qoder', 'mcp.json'), JSON.stringify({
        mcpServers: { qoder: { command: '/bin/echo', args: ['qoder'], env: { TOKEN: 'configured' } } }
      }))
      writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
        mcp: {
          local: { type: 'local', command: ['/bin/echo', 'open'], environment: { LOCAL: '1' } },
          remote: { type: 'remote', url: 'https://remote.example.test', enabled: false }
        }
      }))

      expect(resolveProviderMcpConfigs('codex', cwd, home)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codex-user', scope: 'user', transport: 'stdio', config: expect.objectContaining({ command: '/bin/echo' }) }),
        expect.objectContaining({ name: 'codex-project', scope: 'project', transport: 'http' })
      ]))
      expect(resolveProviderMcpConfigs('qoder', cwd, home)).toContainEqual(expect.objectContaining({
        name: 'qoder', config: expect.objectContaining({ args: ['qoder'], env: { TOKEN: 'configured' } })
      }))
      expect(resolveProviderMcpConfigs('opencode', cwd, home)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'local', enabled: true, config: expect.objectContaining({ command: '/bin/echo', args: ['open'], env: { LOCAL: '1' } }) }),
        expect.objectContaining({ name: 'remote', enabled: false, transport: 'http' })
      ]))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
