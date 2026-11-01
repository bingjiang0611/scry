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
  it.each(['valid', 'session', 'cwd', 'parent', 'agent', 'replay', 'row-scope', 'missing', 'symlink', 'directory-symlink', 'oversize'])(
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
      if (mode !== 'missing') await writeFile(f.childPath, jsonl(childRows) + (mode === 'oversize' ? ' '.repeat(256 * 1024) : ''))
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
})
