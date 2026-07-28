import { describe, expect, it } from 'vitest'
import { mcpCallsForEvent, mcpPayloadFailed, parseMcp } from './trace.js'

describe('MCP shell bridge evidence', () => {
  it('按命令顺序保留同一 shell 中的多个 mcporter call', () => {
    expect(parseMcp('Bash', {
      command: 'mcporter call coop.query --args \'{}\' && "$MCPORTER" call group-env.list --args \'{}\''
    }).mcpCalls).toEqual([
      { server: 'coop', action: 'query', tool: 'mcporter:coop.query' },
      { server: 'group-env', action: 'list', tool: 'mcporter:group-env.list' }
    ])
  })

  it('从旧归档保留的 shell command 回填多个 MCP 调用', () => {
    expect(mcpCallsForEvent({
      isMcp: true,
      tool: 'Bash',
      input: {
        command: "mcporter call coop.get_sub_workitem --args '{}' && mcporter call coop.get_workitem_comments --args '{}'"
      },
      mcpServer: 'coop',
      mcpAction: 'get_sub_workitem',
      mcpTool: 'mcporter:coop.get_sub_workitem'
    })).toEqual([
      { server: 'coop', action: 'get_sub_workitem', tool: 'mcporter:coop.get_sub_workitem' },
      { server: 'coop', action: 'get_workitem_comments', tool: 'mcporter:coop.get_workitem_comments' }
    ])
  })

  it('识别四端可能出现的顶层 JSON 与 Claude/Qoder text envelope 业务失败', () => {
    expect(mcpPayloadFailed('{"success":false,"error":"denied"}')).toBe(true)
    expect(mcpPayloadFailed('log\n{"ok":false}\n')).toBe(true)
    expect(mcpPayloadFailed(JSON.stringify([
      { type: 'text', text: '{"status":"failed","error":"invalid payload"}' }
    ]))).toBe(true)
    expect(mcpPayloadFailed('{"success":true,"data":{"error":"business field"}}')).toBe(false)
    expect(mcpPayloadFailed('plain output mentions error but is not status JSON')).toBe(false)
  })
})
