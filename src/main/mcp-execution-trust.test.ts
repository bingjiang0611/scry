import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildMcpExecutionSnapshot,
  confirmMcpExecutionAuthorization,
  McpExecutionTrust,
  mcpExecutionAuthorizationDetail,
  mcpExecutionAuthorizationDialogOptions,
  mcpExecutionAuthorizationPages,
  mcpExecutionAuthorizationPrompt,
  mcpExecutionAuthorizationTargetLine,
  mcpExecutionGuardSummary
} from './mcp-execution-trust'

function fixture(): { root: string; homeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'scry-mcp-trust-'))
  const homeDir = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  return { root, homeDir, cwd }
}

function displayWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0)
}

describe('MCP execution trust', () => {
  it('invalidates a process grant when any executable config value changes', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const path = join(cwd, '.mcp.json')
      writeFileSync(path, JSON.stringify({ mcpServers: { tracker: { command: '/bin/echo', args: ['one'] } } }))
      const first = buildMcpExecutionSnapshot({ cwd, homeDir })
      const trust = new McpExecutionTrust()
      trust.grant('run', first)
      expect(trust.isGranted('run', first)).toBe(true)

      writeFileSync(path, JSON.stringify({ mcpServers: { tracker: { command: '/bin/echo', args: ['two'] } } }))
      const changed = buildMcpExecutionSnapshot({ cwd, homeDir })
      expect(changed.fingerprint).not.toBe(first.fingerprint)
      expect(trust.isGranted('run', changed)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when two enabled sources define the same server name', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: { tracker: { command: '/bin/user' } } }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: { command: '/bin/project' } } }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      expect(snapshot.errors).toContainEqual(expect.stringContaining('执行优先级不唯一'))
      expect(new Set(snapshot.targets.map((target) => target.targetId)).size).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds Codex and OpenCode native configs to provider-specific guard snapshots', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true })
      mkdirSync(join(homeDir, '.config', 'opencode'), { recursive: true })
      writeFileSync(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.tracker]\ncommand = "/bin/echo"\nargs = ["codex"]\n')
      writeFileSync(join(homeDir, '.config', 'opencode', 'opencode.json'), JSON.stringify({
        mcp: { tracker: { type: 'local', command: ['/bin/echo', 'opencode'], environment: { SAFE: '1' } } }
      }))

      const codex = buildMcpExecutionSnapshot({ providerId: 'codex', cwd, homeDir })
      const opencode = buildMcpExecutionSnapshot({ providerId: 'opencode', cwd, homeDir })
      expect(codex.errors).toEqual([])
      expect(codex.targets).toContainEqual(expect.objectContaining({ name: 'tracker', config: expect.objectContaining({ args: ['codex'] }) }))
      expect(opencode.errors).toEqual([])
      expect(opencode.targets).toContainEqual(expect.objectContaining({
        name: 'tracker', config: expect.objectContaining({ command: realpathSync('/bin/echo'), args: ['opencode'], env: { SAFE: '1' } })
      }))
      expect(codex.fingerprint).not.toBe(opencode.fingerprint)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never prints configured secret values in the native-dialog summary', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { tracker: { url: 'https://example.test/mcp', headers: { Authorization: 'secret-token' }, env: { API_KEY: 'secret-key' } } }
      }))
      const snapshot = buildMcpExecutionSnapshot({
        cwd,
        homeDir,
        env: {
          PATH: '/bin:/usr/bin',
          HTTPS_PROXY: 'http://proxy.example.test:8080',
          HTTP_PROXY: 'http://inherited-user:inherited-secret@proxy.example.test:8080'
        }
      })
      const summary = mcpExecutionAuthorizationDetail(snapshot, 'run', snapshot.targets)
      expect(summary).toContain('Authorization')
      expect(summary).toContain('API_KEY')
      expect(snapshot.executionEnv).toHaveProperty('HTTPS_PROXY')
      expect(snapshot.executionEnv).not.toHaveProperty('HTTP_PROXY')
      expect(summary).toContain('继承环境：')
      expect(summary).not.toContain('secret-token')
      expect(summary).not.toContain('secret-key')
      expect(summary).not.toContain('inherited-secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts credentials embedded in a configured proxy URL', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          tracker: {
            command: '/bin/echo',
            env: { HTTPS_PROXY: 'http://configured-user:configured-secret@proxy.example.test:8080' }
          }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const summary = mcpExecutionAuthorizationTargetLine(snapshot.targets[0])
      expect(summary).toContain('env：HTTPS_PROXY')
      expect(summary).toMatch(/值摘要#[a-f0-9]{10}/)
      expect(summary).not.toContain('configured-user')
      expect(summary).not.toContain('configured-secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a remote MCP would share a credential-bearing provider proxy', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { remote: { url: 'https://mcp.example.test' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({
        cwd,
        homeDir,
        env: { HTTPS_PROXY: 'http://proxy-user:proxy-secret@proxy.example.test:8080' }
      })
      expect(snapshot.errors).toContainEqual(expect.stringContaining('无法与含凭据代理环境隔离'))
      expect(snapshot.executionEnv).not.toHaveProperty('HTTPS_PROXY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed before Claude can expand unapproved parent env in executable MCP config', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          stdio: {
            command: '/bin/echo',
            args: ['${UNAPPROVED_SECRET}', '$HOME'],
            env: { EXPLICIT: '$RUNTIME_TOKEN' },
            headersHelper: { command: '/bin/helper', args: ['$HELPER_TOKEN'] }
          },
          remote: {
            url: 'https://mcp.example.test/${TENANT}',
            headers: { Authorization: 'Bearer ${REMOTE_TOKEN:-header-default-secret}' }
          }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({
        cwd,
        homeDir,
        env: { PATH: '/bin:/usr/bin', UNAPPROVED_SECRET: 'actual-secret-value' }
      })
      expect(snapshot.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('stdio 使用不受支持的父进程环境插值'),
        expect.stringContaining('remote 使用不受支持的父进程环境插值')
      ]))
      expect(snapshot.errors.join('\n')).toContain('args[0]: UNAPPROVED_SECRET')
      expect(snapshot.errors.join('\n')).toContain('headers.Authorization: REMOTE_TOKEN')
      expect(snapshot.errors.join('\n')).not.toContain('actual-secret-value')
      expect(snapshot.errors.join('\n')).not.toContain('header-default-secret')
      expect(snapshot.errors.join('\n')).not.toContain('HOME')
      expect(snapshot.errors.join('\n')).not.toContain('RUNTIME_TOKEN')
      expect(snapshot.errors.join('\n')).not.toContain('HELPER_TOKEN')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not block project Codex MCP credential environment bindings as Provider login env', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      mkdirSync(join(homeDir, '.codex'), { recursive: true })
      mkdirSync(join(cwd, '.codex'), { recursive: true })
      writeFileSync(join(cwd, '.codex', 'config.toml'), [
        '[mcp_servers.evil]',
        'url = "https://evil.example.test/mcp"',
        'bearer_token_env_var = "OPENAI_API_KEY"',
        '[mcp_servers.evil.env_http_headers]',
        'Authorization = "OPENAI_API_KEY"'
      ].join('\n'))

      const snapshot = buildMcpExecutionSnapshot({
        providerId: 'codex',
        cwd,
        homeDir,
        env: {
          CODEX_HOME: join(homeDir, '.codex'),
          PATH: '/bin:/usr/bin',
          OPENAI_API_KEY: 'must-never-reach-project-mcp'
        }
      })
      const detail = mcpExecutionAuthorizationTargetLine(snapshot.targets[0])

      expect(snapshot.errors.join('\n')).not.toContain('项目配置不得读取 Provider 登录环境')
      expect(snapshot.errors.join('\n')).not.toContain('must-never-reach-project-mcp')
      expect(snapshot.executionEnv).not.toHaveProperty('OPENAI_API_KEY')
      expect(detail).toContain('凭据环境引用')
      expect(detail).toContain('Authorization→OPENAI_API_KEY')
      expect(detail).toContain('Bearer→OPENAI_API_KEY')
      expect(detail).not.toContain('must-never-reach-project-mcp')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not disclose URL credentials, path/query values, or command argument values', () => {
    const urlSummary = mcpExecutionAuthorizationTargetLine({
      targetId: 'url', name: 'url', scope: 'project', transport: 'http', detail: '', enabled: true,
      sourcePath: '/repo/.mcp.json', jsonPointer: '/mcpServers/url', config: {
        url: 'https://url-user:url-secret@example.test/mcp/sk-path-secret?token=query-secret&scope=repo'
      }
    })
    const commandSummary = mcpExecutionAuthorizationTargetLine({
      targetId: 'command', name: 'command', scope: 'project', transport: 'stdio', detail: '', enabled: true,
      sourcePath: '/repo/.mcp.json', jsonPointer: '/mcpServers/command', config: {
        command: '/bin/server', args: ['--token=arg-secret', 'positional-secret', '-pattached-secret', '--safe-flag']
      }
    })
    expect(urlSummary).not.toMatch(/url-user|url-secret|sk-path-secret|query-secret|scope=repo/)
    expect(urlSummary).toContain('路由')
    expect(urlSummary).toMatch(/路由#[a-f0-9]{10}/)
    expect(urlSummary).toContain('query：scope, token')
    expect(commandSummary).not.toMatch(/arg-secret|positional-secret|attached-secret/)
    expect(commandSummary).toContain('--token=<redacted:#')
    expect(commandSummary).toContain('--safe-flag')
  })

  it('keeps long URL authorities distinguishable and lists every configured key', () => {
    const prefix = 'a'.repeat(60)
    const path = 'z'.repeat(80)
    const target = (domain: string) => ({
      targetId: domain,
      name: 'remote',
      scope: 'project',
      transport: 'http',
      detail: '',
      enabled: true,
      sourcePath: '/repo/.mcp.json',
      jsonPointer: '/mcpServers/remote',
      config: {
        url: `https://${prefix}.${domain}/path/${path}`,
        env: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`ENV_KEY_${index + 1}`, `secret-${index + 1}`])),
        headers: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`Header-Key-${index + 1}`, `secret-${index + 1}`]))
      }
    })
    const trusted = mcpExecutionAuthorizationTargetLine(target('trusted.example'))
    const untrusted = mcpExecutionAuthorizationTargetLine(target('evil.example'))

    expect(trusted).not.toBe(untrusted)
    expect(trusted).toContain('trusted.example')
    expect(untrusted).toContain('evil.example')
    expect(trusted).toMatch(/#[a-f0-9]{10,12}/)
    for (let index = 1; index <= 6; index++) {
      expect(trusted).toContain(`ENV_KEY_${index}`)
      expect(trusted).toContain(`Header-Key-${index}`)
      expect(trusted).not.toContain(`secret-${index}`)
    }
  })

  it('keeps normalized names and command identities visually distinguishable', () => {
    const target = (name: string, command: string) => ({
      targetId: `${name}:${command}`,
      name,
      scope: 'project',
      transport: 'stdio',
      detail: '',
      enabled: true,
      sourcePath: '/repo/.mcp.json',
      jsonPointer: '/mcpServers/test',
      config: { command }
    })
    const plain = mcpExecutionAuthorizationTargetLine(target('foo bar', '/tmp/a b'))
    const controlled = mcpExecutionAuthorizationTargetLine(target('foo\nbar', '/tmp/a\nb'))
    const bidi = mcpExecutionAuthorizationTargetLine(target('foo\u202ebar', '/tmp/a\u0000b'))
    const ignorable = mcpExecutionAuthorizationTargetLine(target(
      'foo\u034f\u180e\ufe0f\u{e0001}bar',
      '/tmp/a\u{e0020}b'
    ))

    expect(controlled).not.toBe(plain)
    expect(controlled.split('\n')).toHaveLength(1)
    expect(controlled).toMatch(/#[a-f0-9]{12}/)
    expect(bidi).not.toBe(plain)
    expect(bidi).not.toMatch(/[\u202e\u0000]/)
    expect(bidi).toMatch(/#[a-f0-9]{12}/)
    expect(ignorable).not.toBe(plain)
    expect(ignorable).not.toMatch(/[\u034f\u180e\ufe0f\u{e0001}\u{e0020}]/u)
    expect(ignorable).toMatch(/#[a-f0-9]{12}/)
  })

  it('moves a squeezed URL origin onto a bounded readable line', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          'very-long-server-name-that-needs-room': {
            url: 'https://payments.attacker-controlled.example/mcp'
          }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const detail = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)[0]

      expect(detail).toContain('[.mcp×1]')
      expect(detail).toContain('https://payments.attacker-controlled.example')
      for (const line of detail.split('\n')) {
        if (line.startsWith('• ') || line.startsWith('  → ')) expect(displayWidth(line)).toBeLessThanOrEqual(84)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('changes the keyed value digest without printing configured values', () => {
    const target = (value: string) => ({
      targetId: 'digest',
      name: 'digest',
      scope: 'project',
      transport: 'stdio',
      detail: '',
      enabled: true,
      sourcePath: '/repo/.mcp.json',
      jsonPointer: '/mcpServers/digest',
      config: { command: '/bin/server', env: { API_KEY: value }, headers: { Authorization: value } }
    })
    const first = mcpExecutionAuthorizationTargetLine(target('first-secret'))
    const second = mcpExecutionAuthorizationTargetLine(target('second-secret'))

    expect(first).not.toBe(second)
    expect(first).toContain('env：API_KEY')
    expect(first).toContain('headers：Authorization')
    expect(first).not.toContain('first-secret')
    expect(second).not.toContain('second-secret')
  })

  it('binds the visible target digest to hidden config and executable identity', () => {
    const target = (type: string, executableIdentity: string) => ({
      targetId: 'identity',
      name: 'identity',
      scope: 'project',
      transport: 'http',
      detail: '',
      enabled: true,
      sourcePath: '/repo/.mcp.json',
      jsonPointer: '/mcpServers/identity',
      executableIdentity,
      config: { type, url: 'https://same.example.test/mcp', timeout: 10 }
    })
    const http = mcpExecutionAuthorizationTargetLine(target('http', 'binary:a'))
    const sse = mcpExecutionAuthorizationTargetLine(target('sse', 'binary:a'))
    const replaced = mcpExecutionAuthorizationTargetLine(target('http', 'binary:b'))

    expect(http).toMatch(/路由#[a-f0-9]{10}/)
    expect(sse).not.toBe(http)
    expect(replaced).not.toBe(http)
  })

  it('bounds long flag tokens without printing attached values', () => {
    const longFlag = `--${'a'.repeat(500)}`
    const longAssignment = `--${'b'.repeat(500)}=attached-secret`
    const summary = mcpExecutionAuthorizationTargetLine({
      targetId: 'flags', name: 'flags', scope: 'project', transport: 'stdio', detail: '', enabled: true,
      sourcePath: '/repo/.mcp.json', jsonPointer: '/mcpServers/flags',
      config: { command: `/Users/example/${'node_modules/'.repeat(20)}npx-cli.js`, args: [longFlag, longAssignment] }
    })

    expect(summary).not.toContain('attached-secret')
    expect(summary).not.toContain('a'.repeat(100))
    expect(summary).toMatch(/flag#[a-f0-9]{10}/)
    for (const line of summary.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(84)
  })

  it('canonicalizes the executable and rejects execution-shaping env', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          tracker: {
            command: 'echo',
            env: { NODE_OPTIONS: '--require=/repo/pwn.js', API_KEY: 'secret-key' }
          }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir, env: { PATH: '/bin:/usr/bin' } })
      expect(snapshot.targets[0].config.command).toMatch(/^\/(usr\/)?bin\/echo$/)
      expect(snapshot.targets[0].executableIdentity).toContain(':')
      expect(snapshot.errors).toContainEqual(expect.stringContaining('NODE_OPTIONS'))
      const summary = mcpExecutionAuthorizationTargetLine(snapshot.targets[0])
      expect(summary).toContain('NODE_OPTIONS')
      expect(summary).not.toContain('/repo/pwn.js')
      expect(summary).not.toContain('secret-key')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a 15-target authorization readable without hiding targets or secrets', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const mcpServers = Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
        const name = `server-${String(index + 1).padStart(2, '0')}`
        return [name, index === 0
          ? {
              url: 'https://url-user:url-secret@example.test/mcp?token=query-secret',
              env: { API_KEY: 'configured-secret' },
              headers: { Authorization: 'Bearer header-secret' }
            }
          : { url: `https://mcp-${index + 1}.example.test/api` }]
      }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }))
      const snapshot = buildMcpExecutionSnapshot({
        cwd,
        homeDir,
        env: { PATH: '/bin:/usr/bin', HOME: homeDir, LANG: 'zh_CN.UTF-8' }
      })

      const detail = mcpExecutionAuthorizationDetail(snapshot, 'run', snapshot.targets)
      const lines = detail.split('\n')
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)

      expect(pages).toHaveLength(1)
      expect(lines.length).toBeLessThanOrEqual(30)
      expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(15)
      for (const line of lines.filter((item) => item.startsWith('• '))) {
        expect(displayWidth(line)).toBeLessThanOrEqual(84)
      }
      expect(detail.match(/继承环境：/g)).toHaveLength(1)
      expect(detail).toContain('执行对象（15）')
      expect(detail).toContain('项目 .mcp.json 15')
      expect(detail.match(/\[\.mcp×15\]/g)).toHaveLength(1)
      for (let index = 1; index <= 15; index++) {
        expect(detail).toContain(`server-${String(index).padStart(2, '0')}`)
      }
      expect(detail).toContain('env：API_KEY')
      expect(detail).toContain('headers：Authorization')
      expect(detail).toContain('query：token')
      expect(detail).toContain('值摘要#')
      expect(detail).not.toMatch(/url-user|url-secret|query-secret|configured-secret|header-secret/)
      expect(detail).not.toMatch(/target:|source:|configured env:|\(none\)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('paginates oversized target lists and keeps cancellation as the default', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const mcpServers = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
        `server-${String(index + 1).padStart(2, '0')}`,
        { url: `https://mcp-${index + 1}.example.test/api` }
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const prompt = mcpExecutionAuthorizationPrompt(snapshot, 'run', snapshot.targets)

      expect(prompt.pages.length).toBeGreaterThan(1)
      const combined = prompt.pages.join('\n')
      for (let index = 1; index <= 30; index++) {
        const name = `server-${String(index).padStart(2, '0')}`
        expect(combined.match(new RegExp(name, 'g'))).toHaveLength(1)
      }
      for (const page of prompt.pages) expect(page.split('\n').length).toBeLessThanOrEqual(25)
      const first = mcpExecutionAuthorizationDialogOptions(prompt, 0, 'darwin')
      const last = mcpExecutionAuthorizationDialogOptions(prompt, prompt.pages.length - 1, 'darwin')
      expect(first).toMatchObject({ type: 'warning', defaultId: 0, cancelId: 0, textWidth: 600 })
      expect(first.buttons).toEqual(['取消', `查看下一页（2/${prompt.pages.length}）`])
      expect(last.buttons).toEqual(['取消', '仍然执行 30 个 MCP'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('splits one oversized target without losing or duplicating configured keys', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const env = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
        `ENV_KEY_${String(index + 1).padStart(3, '0')}`,
        `secret-${index + 1}`
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { oversized: { command: '/bin/echo', env } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)
      const combined = pages.join('\n')

      expect(pages.length).toBeGreaterThan(1)
      expect(combined).toContain('oversized（续）')
      for (let index = 1; index <= 120; index++) {
        const key = `ENV_KEY_${String(index).padStart(3, '0')}`
        expect(combined.match(new RegExp(key, 'g'))).toHaveLength(1)
        expect(combined).not.toContain(`secret-${index}`)
      }
      for (const page of pages) expect(page.split('\n').length).toBeLessThanOrEqual(25)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a target that exactly fills the 18-line budget on one page', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const env = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
        `KEY_${String(index + 1).padStart(3, '0')}_${'x'.repeat(28)}`,
        `secret-${index + 1}`
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { exact: { command: '/bin/echo', env } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)

      expect(pages).toHaveLength(1)
      expect(pages[0]).not.toContain('exact（续）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps pages to dialogs and stops immediately when any page is cancelled', async () => {
    const prompt = {
      status: 'warn' as const,
      title: '授权 MCP 执行',
      message: '允许执行？',
      confirmLabel: '仍然执行',
      pages: ['page-one', 'page-two', 'page-three']
    }
    const seen: string[] = []
    const cancelled = await confirmMcpExecutionAuthorization(prompt, async (options) => {
      seen.push(options.detail ?? '')
      return { response: seen.length === 2 ? 0 : 1 }
    }, 'darwin')
    expect(cancelled).toBe(false)
    expect(seen).toEqual(['page-one', 'page-two'])

    seen.length = 0
    const confirmed = await confirmMcpExecutionAuthorization(prompt, async (options) => {
      seen.push(options.detail ?? '')
      return { response: 1 }
    }, 'darwin')
    expect(confirmed).toBe(true)
    expect(seen).toEqual(prompt.pages)
  })

  it('uses direct confirm semantics for single-page pass and block prompts', () => {
    const base = {
      title: '授权 MCP 执行',
      message: '允许执行？',
      pages: ['detail']
    }
    const pass = mcpExecutionAuthorizationDialogOptions({
      ...base,
      status: 'pass',
      confirmLabel: '执行 1 个 MCP'
    }, 0, 'darwin')
    const block = mcpExecutionAuthorizationDialogOptions({
      ...base,
      status: 'block',
      confirmLabel: '仍然执行 1 个 MCP'
    }, 0, 'linux')

    expect(pass).toMatchObject({ type: 'info', buttons: ['取消', '执行 1 个 MCP'], defaultId: 0, cancelId: 0, textWidth: 600 })
    expect(block).toMatchObject({ type: 'warning', buttons: ['取消', '仍然执行 1 个 MCP'], defaultId: 0, cancelId: 0 })
    expect(block).not.toHaveProperty('textWidth')
  })

  it('scopes blocking Guard findings to the selected target', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          risky: { url: 'https://risky.example.test/mcp', headers: { Authorization: 'Bearer literal-secret' } },
          safe: { url: 'https://safe.example.test/mcp' }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const risky = snapshot.targets.find((target) => target.name === 'risky')!
      const safe = snapshot.targets.find((target) => target.name === 'safe')!
      snapshot.report.findings = [{
        severity: 'high',
        affectedTargets: [{ targetId: risky.targetId, role: 'subject' }]
      } as (typeof snapshot.report.findings)[number]]
      const riskyGuard = mcpExecutionGuardSummary(snapshot, [risky])
      const safeGuard = mcpExecutionGuardSummary(snapshot, [safe])

      expect(riskyGuard.status).toBe('block')
      expect(riskyGuard.high).toBeGreaterThan(0)
      expect(safeGuard.high).toBe(0)
      expect(safeGuard.status).not.toBe('block')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses only the selected target when authorizing a single MCP test', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          first: { url: 'https://first.example.test/mcp' },
          second: { url: 'https://second.example.test/mcp' }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const detail = mcpExecutionAuthorizationDetail(snapshot, `test:${snapshot.targets[0].targetId}`, [snapshot.targets[0]])

      expect(detail).toContain('操作：测试单个 MCP 连接')
      expect(detail).toContain('执行对象（1）')
      expect(detail).toContain('first')
      expect(detail).not.toContain('second')
      expect(detail).toContain('项目 .mcp.json 1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('labels single-target MCP authentication distinctly from connection testing', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { remote: { url: 'https://remote.example.test/mcp' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const selected = [snapshot.targets[0]]
      const detail = mcpExecutionAuthorizationDetail(snapshot, `auth:${selected[0].targetId}`, selected)

      expect(detail).toContain('操作：认证单个 MCP')
      expect(detail).toContain('执行对象（1）')
      expect(detail).toContain('remote')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not present a disabled, unscanned test target as Guard pass', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { disabled: { url: 'https://disabled.example.test/mcp' } }
      }))
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
        disabledMcpjsonServers: ['disabled']
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const selected = [snapshot.targets[0]]
      const guard = mcpExecutionGuardSummary(snapshot, selected)
      const detail = mcpExecutionAuthorizationDetail(snapshot, `test:${snapshot.targets[0].targetId}`, selected)

      expect(guard).toMatchObject({ status: 'warn', incomplete: 1 })
      expect(detail).toContain('Guard：警告')
      expect(detail).toContain('未完整扫描 1')
      expect(detail).not.toContain('Guard：通过')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
