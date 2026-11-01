import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildMcpExecutionSnapshot,
  mcpExecutionAuthorizationPages,
  mcpExecutionAuthorizationTargetLine
} from './mcp-execution-trust'
import { displayWidth, fixture, join, rmSync, writeFileSync } from './mcp-execution-trust-fixtures'

describe('MCP execution trust', () => {
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

      expect(detail).not.toContain('项目 .mcp.json')
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
      // Ubuntu's echo may resolve through a coreutils symlink outside /usr/bin.
      expect(snapshot.targets[0].config.command).toBe(realpathSync('/bin/echo'))
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

})
