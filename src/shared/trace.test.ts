import { describe, expect, it } from 'vitest'
import { contextUsageEvidence, fileOpOf, mcpCallsForEvent, mcpPayloadFailed, normalizeTurnDiffSnapshot, parseMcp, toolInvocation } from './trace.js'

describe('context usage evidence', () => {
  it('binds context tokens only to the declared model', () => {
    expect(contextUsageEvidence({
      contextTokens: 50,
      contextModel: 'same-model',
      contextProvider: 'new-provider',
      modelUsage: [
        { model: 'same-model', upstreamProvider: 'old-provider', contextWindow: 100 },
        { model: 'same-model', upstreamProvider: 'new-provider', contextWindow: 1_000 }
      ]
    })).toMatchObject({ used: 50, window: 1_000, model: 'same-model', provider: 'new-provider' })
  })

  it('does not guess between same-model rows from different providers', () => {
    expect(contextUsageEvidence({
      contextTokens: 50,
      contextModel: 'shared-model',
      modelUsage: [
        { model: 'shared-model', upstreamProvider: 'provider-a', contextWindow: 100 },
        { model: 'shared-model', upstreamProvider: 'provider-b', contextWindow: 1_000 }
      ]
    })).toBeNull()
  })

  it('does not guess from the only positive window in a multi-model legacy result', () => {
    expect(contextUsageEvidence({
      contextTokens: 50,
      modelUsage: [
        { model: 'old-model', contextWindow: 100 },
        { model: 'new-model' }
      ]
    })).toBeNull()
  })
})

describe('file tool evidence', () => {
  it('normalizes Claude file_path and Pi lowercase path contracts', () => {
    expect(fileOpOf('Read', { file_path: '/repo/CLAUDE.md' })).toEqual({
      fileOp: 'read',
      filePath: '/repo/CLAUDE.md'
    })
    expect(fileOpOf('write', { path: '.claude/intake/REQ-1/intake.md' })).toEqual({
      fileOp: 'write',
      filePath: '.claude/intake/REQ-1/intake.md'
    })
  })
})

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

  it('识别 Qoder 原生 mcp_call 包装器，并取内层参数', () => {
    expect(parseMcp('mcp_call', { toolName: 'mcp__probe__echo', arguments: { text: 'hi' } })).toEqual({
      isMcp: true, mcpServer: 'probe', mcpAction: 'echo', mcpTool: 'mcp__probe__echo',
      mcpCalls: [{ server: 'probe', action: 'echo', tool: 'mcp__probe__echo' }]
    })
    expect(toolInvocation('mcp_call', { toolName: 'mcp__probe__echo', arguments: { text: 'hi' } })).toMatchObject({
      tool: 'mcp__probe__echo',
      input: { text: 'hi' },
      mcp: { isMcp: true, mcpServer: 'probe', mcpAction: 'echo' }
    })
  })

  it('不把其他包装名或不像 mcp__<server>__<action> 的 toolName 猜成 MCP', () => {
    expect(parseMcp('mcp_get', { toolName: 'mcp__probe__echo' }).isMcp).toBe(false)
    expect(parseMcp('mcp_call', { toolName: 'not-a-mcp-tool', arguments: {} }).isMcp).toBe(false)
    expect(parseMcp('mcp_call', { toolName: 'mcp__probe', arguments: {} }).isMcp).toBe(false)
    expect(parseMcp('mcp_call', {}).isMcp).toBe(false)
    expect(toolInvocation('mcp_get', { toolName: 'mcp__probe__echo' })).toMatchObject({
      tool: 'mcp_get', input: { toolName: 'mcp__probe__echo' }
    })
  })

  it('从旧归档的 mcp_call 事件回填包装调用', () => {
    expect(mcpCallsForEvent({
      isMcp: true,
      tool: 'mcp_call',
      input: { toolName: 'mcp__probe__echo', arguments: { text: 'hi' } },
      mcpServer: 'probe',
      mcpAction: 'echo',
      mcpTool: 'mcp__probe__echo'
    })).toEqual([{ server: 'probe', action: 'echo', tool: 'mcp__probe__echo' }])
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

describe('turn diff patch policy', () => {
  it('保留 policy 省略原因', () => {
    expect(normalizeTurnDiffSnapshot({
      version: 1,
      status: 'captured',
      files: [{ path: '/repo/.factorypath', added: 1, deleted: 1, change: 'modified', patchStatus: 'unavailable', patchReason: 'policy' }],
      beforeAt: '2026-01-01T00:00:00.000Z',
      afterAt: '2026-01-01T00:00:01.000Z',
      captureMs: 1,
      cleanup: 'ok'
    })?.files[0]).toMatchObject({ change: 'modified', patchStatus: 'unavailable', patchReason: 'policy' })
  })
})
