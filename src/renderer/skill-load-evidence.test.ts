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
