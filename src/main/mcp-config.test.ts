import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizedMcpRuntimeEnv,
  listMcp,
  mcpDisabledSet,
  minimalMcpEnv,
  parseToolNames,
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

  it('解析 direct JSON 和 SSE tools/list 响应', () => {
    expect(parseToolNames(JSON.stringify({ result: { tools: [{ name: 'query' }, { name: 'update' }] } }))).toEqual([
      'query',
      'update'
    ])
    expect(parseToolNames('event: message\ndata: {"result":{"tools":[{"name":"tracker.query"}]}}\n\n')).toEqual([
      'tracker.query'
    ])
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
})
