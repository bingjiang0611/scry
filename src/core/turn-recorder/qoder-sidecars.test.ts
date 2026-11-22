import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { stableTranscript } from './recorder-transcript-cache'
import { listRecords } from './store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-sidecars-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'test', capture: { diff: false } }))
  const path = join(root, 'session.jsonl')
  const childPath = join(root, 'session', 'subagents', 'agent-child.jsonl')
  const identity = { sessionId: 'session', cwd: root }
  const parentRows = [
    { ...identity, type: 'user', uuid: 'u', requestSetId: 'R', promptId: 'P', message: { role: 'user', content: 'inspect' } },
    { ...identity, type: 'assistant', uuid: 'a', parentUuid: 'u', message: { id: 'parent-call', content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'read' } }] } },
    { ...identity, type: 'user', uuid: 'r', parentUuid: 'a', promptId: 'P',
      toolUseResult: { kind: 'agent-result', agentId: 'child', state: 'completed', transcriptPath: '/untrusted/path/must-not-be-opened.jsonl' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'child finished' }] } },
    { ...identity, type: 'assistant', uuid: 'done', parentUuid: 'r',
      message: { id: 'main-answer', content: [{ type: 'text', text: 'root answer' }], usage: { input_tokens: 5, output_tokens: 2 } } }
  ]
  const childIdentity = { ...identity, agentId: 'child', parent_tool_use_id: 'spawn', isSidechain: true }
  const childRows = [
    { ...childIdentity, type: 'user', uuid: 'cu', isDelegatedTask: true, promptId: 'session', message: { role: 'user', content: 'read' } },
    { ...childIdentity, type: 'assistant', uuid: 'ca', parentUuid: 'cu', message: { id: 'child-call', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'seed.txt' } }] } },
    { ...childIdentity, type: 'user', uuid: 'cr', parentUuid: 'ca', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'seed' }] } },
    { ...childIdentity, type: 'assistant', uuid: 'cd', parentUuid: 'cr', message: { id: 'child-answer', content: [{ type: 'text', text: 'child answer' }], usage: { input_tokens: 999, output_tokens: 999 } } }
  ]
  await mkdir(join(root, 'session', 'subagents'), { recursive: true })
  await writeFile(path, '')
  return {
    root, path, childPath,
    parentRows: parentRows.map((row, index) => ({ ...row, timestamp: `2026-09-09T00:00:00.${['000', '100', '800', '900'][index]}Z` })),
    childRows: childRows.map((row, index) => ({ ...row, timestamp: `2026-09-09T00:00:00.${index + 2}00Z` }))
  }
}

describe('Qoder native sidecar custody and attribution', () => {
  it.each(['valid', 'session', 'cwd', 'parent', 'agent', 'replay', 'row-scope', 'missing', 'symlink', 'directory-symlink'])(
    'canonical child calls keep proven parents without duplicated usage: %s', async mode => {
      const f = await fixture()
      const base = { session_id: 'session', cwd: f.root, transcript_path: f.path }
      await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
        ...base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
      } })
      const childRows: Array<Record<string, unknown>> = f.childRows
      if (mode === 'session') childRows[0].sessionId = 'foreign'
      if (mode === 'cwd') childRows[0].cwd = '/foreign'
      if (mode === 'parent') childRows[0].parent_tool_use_id = 'foreign'
      if (mode === 'agent') childRows[0].agentId = 'foreign'
      if (mode === 'replay') childRows[0].isReplay = true
      if (mode === 'row-scope') childRows[1].parent_tool_use_id = 'foreign'
      if (mode !== 'missing') await writeFile(f.childPath, jsonl(childRows))
      if (mode === 'symlink') {
        const outside = join(f.root, 'outside.jsonl')
        await writeFile(outside, jsonl(childRows))
        await rm(f.childPath)
        await symlink(outside, f.childPath)
      }
      if (mode === 'directory-symlink') {
        const outside = join(f.root, 'outside')
        await mkdir(join(outside, 'subagents'), { recursive: true })
        await writeFile(join(outside, 'subagents', 'agent-child.jsonl'), jsonl(childRows))
        await rm(join(f.root, 'session'), { recursive: true })
        await symlink(outside, join(f.root, 'session'))
      }
      await writeFile(f.path, jsonl(f.parentRows))
      // Real hooks expose this logical child call, but not its parent relation.
      for (const [event, timestamp, detail] of [
        ['PreToolUse:Read', '2026-09-09T00:00:00.200Z', { tool_input: { file_path: 'seed.txt' } }],
        ['PostToolUse:Read', '2026-09-09T00:00:00.300Z', { tool_response: 'seed' }]
      ] as const) await handleRecorderHook({ provider: 'qoder', workspace: f.root, event, payload: {
        ...base, parent_request_set_id: 'R', tool_name: 'Read', tool_use_id: 'read', timestamp, ...detail
      } })
      await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
        ...base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
      } })
      const records = await listRecords(join(f.root, '.scry'))
      expect(records).toHaveLength(1)
      const record = records[0]
      expect(record.providerTurnId).toBe('P')
      expect(record.tools.value?.filter(tool => tool.id === 'read')).toHaveLength(1)
      expect(record.assistant.value?.text).toBe('root answer')
      expect(record.usage.value).toMatchObject({ inputTokens: 5, outputTokens: 2 })
      if (mode === 'valid') {
        expect(record.tools.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'read', parentId: 'spawn' })]))
        expect(record.modelSegments?.value).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'child answer', agentId: 'child', parentId: 'spawn' })]))
      } else {
        expect(record.tools.status).toBe('partial')
        expect(record.tools.value?.find(tool => tool.id === 'read')?.parentId).toBeUndefined()
        expect(record.modelSegments?.value?.some(segment => segment.agentId === 'child')).toBe(false)
      }
    })

  it.each(['null', 'absent'] as const)(
    'accepts Qoder 1.1.93 child rows whose parent_tool_use_id is %s', async shape => {
      const f = await fixture()
      const base = { session_id: 'session', cwd: f.root, transcript_path: f.path }
      await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
        ...base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
      } })
      // 真实 1.1.93 子行把 parent_tool_use_id 写成 null（或未写）；归属由父结果 agentId、
      // 子文件名、sessionId、cwd、agentId、isSidechain 证明，不靠这一列。
      const childRows = f.childRows.map(row => {
        if (shape === 'null') return { ...row, parent_tool_use_id: null }
        const { parent_tool_use_id: _omitted, ...rest } = row
        return rest
      })
      await writeFile(f.childPath, jsonl(childRows))
      await writeFile(f.path, jsonl(f.parentRows))
      for (const [event, timestamp, detail] of [
        ['PreToolUse:Read', '2026-09-09T00:00:00.200Z', { tool_input: { file_path: 'seed.txt' } }],
        ['PostToolUse:Read', '2026-09-09T00:00:00.300Z', { tool_response: 'seed' }]
      ] as const) await handleRecorderHook({ provider: 'qoder', workspace: f.root, event, payload: {
        ...base, parent_request_set_id: 'R', tool_name: 'Read', tool_use_id: 'read', timestamp, ...detail
      } })
      await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
        ...base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
      } })

      const records = await listRecords(join(f.root, '.scry'))
      expect(records).toHaveLength(1)
      const record = records[0]
      // hook 与子文件描述同一次调用：只留一条，且带父调用 ID。
      expect(record.tools.value?.filter(tool => tool.id === 'read')).toHaveLength(1)
      expect(record.tools.value?.find(tool => tool.id === 'read')?.parentId).toBe('spawn')
      expect(record.modelSegments?.value).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'child answer', agentId: 'child', parentId: 'spawn' })
      ]))
      expect(record.tools.omissionReason).toBeUndefined()
      expect(record.tools.status).toBe('available')
    }
  )

  it('still rejects a child row that names a different parent call', async () => {
    const f = await fixture()
    const base = { session_id: 'session', cwd: f.root, transcript_path: f.path }
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
    } })
    await writeFile(f.childPath, jsonl(f.childRows.map((row, index) => index === 2
      ? { ...row, parent_tool_use_id: 'other-call' }
      : { ...row, parent_tool_use_id: null })))
    await writeFile(f.path, jsonl(f.parentRows))
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
      ...base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
    } })

    const records = await listRecords(join(f.root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].modelSegments?.value?.some(segment => segment.agentId === 'child')).toBe(false)
    expect(records[0].tools.status).toBe('partial')
  })

  it('does not cache sidecar availability under an unchanged root transcript identity', async () => {
    const f = await fixture()
    await writeFile(f.path, jsonl(f.parentRows))
    const read = () => stableTranscript(f.path, 'qoder:session', 'qoder', undefined, 'P', undefined, 'R', 'session', f.root)
    const missing = await read()
    expect(missing.complete).toBe(false)
    await writeFile(f.childPath, jsonl(f.childRows))
    const present = await read()
    expect(present.identityMatched).toBe(true)
    expect(present.complete).toBe(true)
    expect(present.events).toEqual(expect.arrayContaining([expect.objectContaining({ toolUseId: 'read', parentToolUseId: 'spawn' })]))
  })

  it('keeps the rows that fit of a 600 KB child transcript and names the truncation in the record', async () => {
    const f = await fixture()
    const lateChildText = 'late child analysis '.repeat(32 * 1024)
    // One oversized assistant row straddles the byte budget, so the cut lands mid-line and the
    // retained prefix must end on a row boundary rather than parsing half of it.
    const oversizeChild = jsonl([
      ...f.childRows,
      { ...f.childRows[0], type: 'assistant', uuid: 'late', parentUuid: 'cd', message: { id: 'late-answer', content: [{ type: 'text', text: lateChildText }] } }
    ])
    expect(Buffer.byteLength(oversizeChild)).toBeGreaterThan(600_000)
    const base = { session_id: 'session', cwd: f.root, transcript_path: f.path }
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
    } })
    await writeFile(f.childPath, oversizeChild)
    await writeFile(f.path, jsonl(f.parentRows))
    for (const [event, timestamp, detail] of [
      ['PreToolUse:Read', '2026-09-09T00:00:00.200Z', { tool_input: { file_path: 'seed.txt' } }],
      ['PostToolUse:Read', '2026-09-09T00:00:00.300Z', { tool_response: 'seed' }]
    ] as const) await handleRecorderHook({ provider: 'qoder', workspace: f.root, event, payload: {
      ...base, parent_request_set_id: 'R', tool_name: 'Read', tool_use_id: 'read', timestamp, ...detail
    } })
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
      ...base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
    } })

    const records = await listRecords(join(f.root, '.scry'))
    expect(records).toHaveLength(1)
    const record = records[0]
    // The child's internal evidence inside the budget survives; the parent's answer and usage stay authoritative.
    expect(record.assistant.value?.text).toBe('root answer')
    expect(record.usage.value).toMatchObject({ inputTokens: 5, outputTokens: 2 })
    expect(record.tools.value?.filter(tool => tool.id === 'read')).toHaveLength(1)
    expect(record.tools.value?.find(tool => tool.id === 'read')?.parentId).toBe('spawn')
    expect(record.modelSegments?.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'child answer', agentId: 'child', parentId: 'spawn' })
    ]))
    // Bytes beyond the budget were never parsed, so they cannot be claimed.
    expect(record.modelSegments?.value?.some(segment => segment.text?.includes('late child analysis'))).toBe(false)

    // Partial status is preserved, and the reason names the child, the cause and how much was kept.
    expect(record.tools.status).toBe('partial')
    const reason = record.tools.omissionReason ?? ''
    const truncation = /child agent transcript exceeds the 262144 byte per-child budget \(agent child, (.+agent-child\.jsonl)\): kept (\d+) of (\d+) bytes/.exec(reason)
    expect(truncation).not.toBeNull()
    const retained = Number(truncation![2])
    const total = Number(truncation![3])
    expect(total).toBe(Buffer.byteLength(oversizeChild))
    expect(retained).toBeLessThanOrEqual(262_144)
    expect(retained).toBeGreaterThan(0)
    expect(reason).toContain('transcript snapshot was incomplete')
  })

  it('reads a child transcript under the budget without a truncation claim', async () => {
    const f = await fixture()
    const base = { session_id: 'session', cwd: f.root, transcript_path: f.path }
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R', prompt: 'inspect', timestamp: '2026-09-09T00:00:00.000Z'
    } })
    await writeFile(f.childPath, jsonl(f.childRows))
    await writeFile(f.path, jsonl(f.parentRows))
    await handleRecorderHook({ provider: 'qoder', workspace: f.root, event: 'Stop', payload: {
      ...base, parent_request_set_id: 'R', timestamp: '2026-09-09T00:00:01.000Z'
    } })
    const records = await listRecords(join(f.root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].tools.omissionReason).toBeUndefined()
    expect(records[0].tools.status).toBe('available')
  })
})
