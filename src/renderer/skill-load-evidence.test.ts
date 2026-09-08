import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { aggregateCalls, logicalCallEventsForTurn } from './format'
import { isInferredSkillLoad } from './skill-load-evidence'
import { sessionCapabilityCalls } from './session-capability-calls'

const read: TraceEvent = {
  id: 'read-skill', runId: 'run-1', ts: '', providerId: 'qoder', runtimeProvider: 'qoder_cli',
  kind: 'tool', stage: 'tool:Read', tool: 'Read', name: 'Read', toolUseId: 'read-1',
  fileOp: 'read', filePath: '/repo/rate-native/.claude/skills/hsf-invoke/SKILL.md',
  input: { file_path: '/repo/rate-native/.claude/skills/hsf-invoke/SKILL.md' }
}
const response: TraceEvent = {
  ...read, id: 'read-result', stage: 'tool_result', isError: false,
  output: '1\t---\n2\tname: hsf-invoke\n3\t---\n4\t# hsf-invoke'
}
const prompt = '/rate-native-hsf-invoke 排查接口为什么没数据'
const count = (items: TraceEvent[], userText = prompt) => aggregateCalls(logicalCallEventsForTurn(items, userText))

describe('user-requested Skill file loading evidence', () => {
  it('recovers the Qoder successful Read pattern without inventing another tool call or mutating the archive', () => {
    const items = [read, response]
    const before = JSON.stringify(items)
    const projected = logicalCallEventsForTurn(items, prompt)
    expect(projected[0]).toMatchObject({ id: read.id, name: 'hsf-invoke', kind: 'skill', tool: 'Read' })
    expect(isInferredSkillLoad(projected[0])).toBe(true)
    expect(count(items)).toMatchObject({ skillTotal: 1, ordinaryToolTotal: 0, totalCalls: 1 })
    expect(JSON.stringify(items)).toBe(before)
  })

  it.each(['/hsf-invoke 查询', '/skill:hsf-invoke 查询', prompt])('recognizes the explicit invocation %s', (text) => {
    expect(count([read, response], text).skillTotal).toBe(1)
  })

  it.each(['提到 /hsf-invoke', '检查所有技能定义', '/unused-skill', '/wrong-project-hsf-invoke', ''])('does not promote browsing or mismatched intent: %s', (text) => {
    expect(count([read, response], text)).toMatchObject({ skillTotal: 0, ordinaryToolTotal: 1 })
  })

  it('requires a correlated successful result, not merely an attempted or failed read', () => {
    for (const result of [undefined, { ...response, isError: true }, { ...response, isError: undefined }, { ...response, toolUseId: 'other' }, { ...response, filePath: '/different/SKILL.md' }]) {
      expect(count(result ? [read, result] : [read]).skillTotal).toBe(0)
    }
  })

  it('does not infer from Bash references or arbitrary SKILL.md files', () => {
    expect(count([{ ...read, tool: 'Bash', stage: 'tool:Bash', input: { command: 'git show HEAD:.claude/skills/hsf-invoke/SKILL.md' } }, response]).skillTotal).toBe(0)
    expect(count([{ ...read, filePath: '/repo/docs/hsf-invoke/SKILL.md' }, response]).skillTotal).toBe(0)
  })

  it('deduplicates progress and repeated reads without inflating tool totals', () => {
    const items = [read, { ...read, id: 'progress' }, response, { ...read, id: 'reread', toolUseId: 'read-2' }, { ...response, id: 'reread-result', toolUseId: 'read-2' }]
    expect(count(items)).toMatchObject({ skillTotal: 1, ordinaryToolTotal: 1, totalCalls: 2 })
  })

  it('does not double count a native Skill invocation or injection with a following read', () => {
    for (const input of [{ source: 'skill_injection' }, {}]) {
      const direct: TraceEvent = { id: 'direct', runId: read.runId, ts: '', kind: 'skill', stage: 'skill:hsf-invoke', name: 'hsf-invoke', input }
      expect(count([direct, read, response])).toMatchObject({ skillTotal: 1, ordinaryToolTotal: 1, totalCalls: 2 })
      expect(logicalCallEventsForTurn([direct, read, response], prompt).some(isInferredSkillLoad)).toBe(false)
    }
  })

  it.each([
    { label: 'another run', result: { ...response, runId: 'run-other' } },
    { label: 'a subagent reusing the call id', result: { ...response, agentId: 'child-agent' } },
    { label: 'another tool', result: { ...response, tool: 'Write' } },
    { label: 'a non-tool event', result: { ...response, kind: 'model' as const } }
  ])('does not borrow success from $label', ({ result }) => {
    expect(count([read, result]).skillTotal).toBe(0)
  })

  it('keeps a successful result when a duplicate without outcome arrives later', () => {
    const partial = { ...response, id: 'shadow-result', isError: undefined }
    for (const results of [[response, partial], [partial, response]]) {
      expect(count([read, ...results])).toMatchObject({ skillTotal: 1, totalCalls: 1 })
    }
  })

  it('does not assert successful loading when correlated terminal outcomes conflict', () => {
    const failed = { ...response, id: 'conflicting-result', isError: true }
    for (const results of [[response, failed], [failed, response]]) {
      expect(count([read, ...results]).skillTotal).toBe(0)
    }
  })

  it('reprojects pending → success and session switches without retaining inferred events', () => {
    const turn = { runId: read.runId, userText: prompt, items: [read], done: false }
    expect(sessionCapabilityCalls([turn])).toEqual([])
    expect(sessionCapabilityCalls([{ ...turn, items: [read, response] }])[0]).toMatchObject({ name: 'hsf-invoke', inferredCount: 1 })
    expect(sessionCapabilityCalls([turn])).toEqual([])
    expect(read.kind).toBe('tool')
    expect(read.input).not.toHaveProperty('source')
  })

  it('matches reordered read/result evidence without depending on array position', () => {
    expect(count([response, read])).toMatchObject({ skillTotal: 1, totalCalls: 1 })
  })

  it('keeps direct and inferred usage provenance separate across turns sharing tool ids', () => {
    const loaded = { runId: read.runId, userText: prompt, items: [read, response], done: true }
    const direct: TraceEvent = { ...read, id: 'native', runId: 'run-2', kind: 'skill', stage: 'tool:Skill', tool: 'Skill', name: 'hsf-invoke' }
    const rows = sessionCapabilityCalls([loaded, { ...loaded, runId: 'run-2', items: [direct] }])
    expect(rows[0]).toMatchObject({ count: 2, inferredCount: 1, event: read })
  })

  it('counts loaded turns independently, labels inference and links back to the original Read', () => {
    const turn = { runId: read.runId, userText: prompt, items: [read, response], done: true }
    const rows = sessionCapabilityCalls([turn])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'hsf-invoke', count: 1, inferredCount: 1 })
    expect(rows[0].event).toBe(read)
    expect(sessionCapabilityCalls([turn, { ...turn, runId: 'run-2' }])[0]).toMatchObject({ count: 2, inferredCount: 2 })
    expect(sessionCapabilityCalls([{ ...turn, userText: 'new session', items: [] }])).toEqual([])
  })
})
