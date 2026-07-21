import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMcp, mcpDisabledSet, parseToolNames, toggleMcp } from './mcp-config'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-mcp-'))

describe('mcp-config', () => {
  it('解析 direct JSON 和 SSE tools/list 响应', () => {
    expect(parseToolNames(JSON.stringify({ result: { tools: [{ name: 'query' }, { name: 'update' }] } }))).toEqual([
      'query',
      'update'
    ])
    expect(parseToolNames('event: message\ndata: {"result":{"tools":[{"name":"tracker.query"}]}}\n\n')).toEqual([
      'tracker.query'
    ])
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
