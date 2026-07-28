import { describe, expect, it } from 'vitest'
import { mcpCallsForEvent, mcpPayloadFailed, parseMcp } from './trace.js'

describe('MCP shell bridge evidence', () => {
  it('按命令顺序保留同一 shell 中的多个 mcporter call', () => {
    expect(parseMcp('Bash', {
      command: 'mcporter call workitem.query --args \'{}\' && "$MCPORTER" call env-config.list --args \'{}\''
    }).mcpCalls).toEqual([
      { server: 'workitem', action: 'query', tool: 'mcporter:workitem.query' },
      { server: 'env-config', action: 'list', tool: 'mcporter:env-config.list' }
    ])
  })

  it('从旧归档保留的 shell command 回填多个 MCP 调用', () => {
    expect(mcpCallsForEvent({
      isMcp: true,
      tool: 'Bash',
      input: {
        command: "mcporter call workitem.get_sub_workitem --args '{}' && mcporter call workitem.get_workitem_comments --args '{}'"
      },
      mcpServer: 'workitem',
      mcpAction: 'get_sub_workitem',
      mcpTool: 'mcporter:workitem.get_sub_workitem'
    })).toEqual([
      { server: 'workitem', action: 'get_sub_workitem', tool: 'mcporter:workitem.get_sub_workitem' },
      { server: 'workitem', action: 'get_workitem_comments', tool: 'mcporter:workitem.get_workitem_comments' }
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
