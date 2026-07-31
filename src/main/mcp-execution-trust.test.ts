import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMcpExecutionSnapshot, McpExecutionTrust, mcpTargetSummary } from './mcp-execution-trust'

function fixture(): { root: string; homeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'scry-mcp-trust-'))
  const homeDir = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  return { root, homeDir, cwd }
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
      const summary = mcpTargetSummary(snapshot.targets[0], snapshot.executionEnv)
      expect(summary).toContain('Authorization')
      expect(summary).toContain('API_KEY')
      expect(summary).toContain('HTTPS_PROXY')
      expect(summary).not.toContain('HTTP_PROXY')
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
      const summary = mcpTargetSummary(snapshot.targets[0], snapshot.executionEnv)
      expect(summary).toContain('HTTPS_PROXY=<redacted sha256:')
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

  it('does not disclose URL credentials, query values, or command argument values', () => {
    const urlSummary = mcpTargetSummary({
      targetId: 'url', name: 'url', scope: 'project', transport: 'http', detail: '', enabled: true,
      sourcePath: '/repo/.mcp.json', jsonPointer: '/mcpServers/url', config: {
        url: 'https://url-user:url-secret@example.test/mcp?token=query-secret&scope=repo'
      }
    })
    const commandSummary = mcpTargetSummary({
      targetId: 'command', name: 'command', scope: 'project', transport: 'stdio', detail: '', enabled: true,
      sourcePath: '/repo/.mcp.json', jsonPointer: '/mcpServers/command', config: {
        command: '/bin/server', args: ['--token=arg-secret', 'positional-secret', '--safe-flag']
      }
    })
    expect(urlSummary).not.toMatch(/url-user|url-secret|query-secret|scope=repo/)
    expect(urlSummary).toContain('token=%3Credacted%3E')
    expect(commandSummary).not.toMatch(/arg-secret|positional-secret/)
    expect(commandSummary).toContain('--token=<redacted>')
    expect(commandSummary).toContain('--safe-flag')
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
      const summary = mcpTargetSummary(snapshot.targets[0])
      expect(summary).toContain('NODE_OPTIONS="--require=/repo/pwn.js"')
      expect(summary).not.toContain('secret-key')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
