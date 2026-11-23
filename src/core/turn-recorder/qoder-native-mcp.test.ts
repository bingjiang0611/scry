import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { listRecords } from './store'

// Qoder 1.1.93 原生 MCP 调用只保留一种形状：tool_use.name=mcp_call，
// input.toolName 是 mcp__<server>__<action>，真实参数在 input.arguments。
// 夹具只写字段形状，不放提示、回答或参数正文以外的内容。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-mcp-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'test', capture: { diff: false } }))
  const path = join(root, 'session.jsonl')
  const identity = { sessionId: 'session', cwd: root }
  const promptRow = { ...identity, type: 'user', uuid: 'u', promptId: 'P', requestSetId: 'R', message: { role: 'user', content: 'inspect' } }
  const usage = { input_tokens: 5, output_tokens: 2 }
  return { root, path, identity, promptRow, usage, base: { session_id: 'session', cwd: root, transcript_path: path } }
}

function mcpCallRows(args: { identity: Record<string, unknown>; usage: Record<string, number> }) {
  return [
    {
      ...args.identity, type: 'assistant', uuid: 'a', parentUuid: 'u',
      message: { id: 'mcp-call', content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp_call', input: { toolName: 'mcp__probe__echo', arguments: { text: 'hi' } } }] }
    },
    {
      ...args.identity, type: 'user', uuid: 'r', parentUuid: 'a', promptId: 'P',
      toolUseResult: { isHardFailure: false },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: 'echo:{"text":"hi"}' }] }
    },
    {
      ...args.identity, type: 'assistant', uuid: 'done', parentUuid: 'r', promptId: 'P',
      message: { id: 'answer', content: [{ type: 'text', text: 'done' }], usage: args.usage, stop_reason: 'end_turn' }
    }
  ]
}

describe('Qoder native mcp_call wrapper evidence', () => {
  it('transcript 里的 mcp_call 记录为 MCP 调用，不占普通工具', async () => {
    const f = await fixture()
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
      ...f.base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
    } })
    await writeFile(f.path, jsonl([
      { ...f.promptRow, timestamp: '2026-09-09T00:00:00.100Z' },
      ...mcpCallRows({ identity: f.identity, usage: f.usage }).map((row, index) => ({
        ...row, timestamp: `2026-09-09T00:00:00.${index + 2}00Z`
      }))
    ]))
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
      ...f.base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
    } })

    const records = await listRecords(join(f.root, '.scry'))
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.mcps.value).toEqual([
      expect.objectContaining({
        id: 'mcp-1',
        category: 'mcp',
        name: 'mcp__probe__echo',
        // 记录的参数必须是包装器内层 input.arguments，而不是 {toolName, arguments} 外壳。
        inputContent: expect.objectContaining({ content: JSON.stringify({ text: 'hi' }) }),
        mcp: { server: 'probe', action: 'echo', tool: 'mcp__probe__echo' },
        status: 'success'
      })
    ])
    // 互斥口径：同一次调用不能既进 mcps 又进 tools。
    expect(record.tools.value ?? []).toEqual([])
  })

  it('PreToolUse/PostToolUse 包装事件与 transcript 合并后仍只有一次 MCP 调用', async () => {
    const f = await fixture()
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
      ...f.base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
    } })
    for (const [event, timestamp, detail] of [
      ['PreToolUse:mcp_call', '2026-09-09T00:00:00.400Z', { tool_input: { toolName: 'mcp__probe__echo', arguments: { text: 'hi' } } }],
      ['PostToolUse:mcp_call', '2026-09-09T00:00:00.600Z', { tool_response: 'echo:{"text":"hi"}' }]
    ] as const) await handleRecorderHook({ provider: 'qoder', workspace: f.root, event, payload: {
      ...f.base, parent_request_set_id: 'R', tool_name: 'mcp_call', tool_use_id: 'mcp-1', timestamp, ...detail
    } })
    await writeFile(f.path, jsonl([
      { ...f.promptRow, timestamp: '2026-09-09T00:00:00.100Z' },
      ...mcpCallRows({ identity: f.identity, usage: f.usage }).map((row, index) => ({
        ...row, timestamp: `2026-09-09T00:00:00.${index + 2}00Z`
      }))
    ]))
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
      ...f.base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
    } })

    const records = await listRecords(join(f.root, '.scry'))
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.mcps.value).toHaveLength(1)
    expect(record.mcps.value?.[0]).toMatchObject({
      id: 'mcp-1', category: 'mcp', mcp: { server: 'probe', action: 'echo', tool: 'mcp__probe__echo' }
    })
    expect(record.tools.value ?? []).toEqual([])
  })
})
