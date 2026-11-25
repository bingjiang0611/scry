import { describe, expect, it } from 'vitest'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { parseTranscriptToTurns } from './normalize'

/**
 * Qoder 用两种行表达同一个 Skill 事实：宿主激活通知（system informational）与注入正文
 * （isMeta + 字符串 content）。两者都是宿主证据，不是模型正文；同一次激活只记一条。
 */

const AT = (second: number): string => `2026-11-16T08:00:${String(second).padStart(2, '0')}.000Z`

function parse(...rows: unknown[]): ReturnType<typeof parseTranscriptToTurns> {
  const content = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  return parseTranscriptToTurns(content, {
    runId: 'qoder:demo:1',
    newId: () => `id-${Math.random().toString(36).slice(2, 8)}`,
    now: () => AT(59),
    providerId: 'qoder'
  })
}

const prompt = { type: 'user', uuid: 'u-1', timestamp: AT(1), message: { role: 'user', content: '按流程执行' } }
const activation = {
  type: 'system', subtype: 'informational', uuid: 's-1', timestamp: AT(2), level: 'info',
  content: 'Skill **demo:cart-skill** activated.'
}
const injection = {
  type: 'user', uuid: 'u-meta', timestamp: AT(3), isMeta: true,
  message: { role: 'user', content: 'Base directory for this skill: /Users/demo/.plugins/demo/1.0.0/skills/cart-skill\n\n# 示例技能' }
}
const answer = {
  type: 'assistant', uuid: 'a-1', timestamp: AT(4),
  message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: '开始执行。' }] }
}

function skillsOf(turns: ReturnType<typeof parseTranscriptToTurns>) {
  return aggregateTurnEvidence({
    userText: '按流程执行',
    events: turns.flatMap((turn) => turn.items),
    observable: { skills: true }
  })
}

describe('Skill 证据', () => {
  it('激活通知与字符串形式注入合成一条证据，并保留两种来源时间', () => {
    const turns = parse(prompt, activation, injection, answer)
    const skills = skillsOf(turns).skills
    expect(skills.value).toHaveLength(1)
    expect(skills.value?.[0]).toMatchObject({ category: 'skill', name: 'demo:cart-skill' })
    expect(skills.value?.[0]?.input).toEqual({
      source: 'skill_activation',
      activatedAt: AT(2),
      injectedAt: AT(3),
      injectedName: 'cart-skill'
    })
    expect(aggregateTurnEvidence({ userText: '按流程执行', events: turns.flatMap((turn) => turn.items) })
      .assistant.value?.text).toBe('开始执行。')
  })

  it('只有字符串形式注入时也能识别，来源记为注入', () => {
    const turns = parse(prompt, injection, answer)
    const skills = skillsOf(turns).skills
    expect(skills.value).toHaveLength(1)
    expect(skills.value?.[0]?.input).toEqual({ source: 'skill_injection', injectedAt: AT(3) })
  })

  it('只有激活通知时保留激活来源，不凭空生成注入', () => {
    const turns = parse(prompt, activation, answer)
    expect(skillsOf(turns).skills.value).toEqual([
      expect.objectContaining({ name: 'demo:cart-skill', input: { source: 'skill_activation', activatedAt: AT(2) } })
    ])
  })

  it('同一技能只记一条，但下一轮重新激活要另起一条', () => {
    const nextPrompt = { type: 'user', uuid: 'u-2', timestamp: AT(30), message: { role: 'user', content: '再来一次' } }
    const turns = parse(prompt, activation, injection, answer, nextPrompt, activation, injection, answer)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.items.filter((event) => event.kind === 'skill')).toHaveLength(1)
    expect(turns[1]?.items.filter((event) => event.kind === 'skill')).toHaveLength(1)
  })

  it('真实 Skill 工具调用优先于注入标记，调用数不因注入翻倍', () => {
    const skillCall = {
      type: 'assistant', uuid: 'a-s', timestamp: AT(5),
      message: { id: 'm-s', role: 'assistant', content: [{ type: 'tool_use', id: 'call-skill', name: 'Skill', input: { skill: 'cart-skill' } }] }
    }
    const skillResult = {
      type: 'user', uuid: 'u-s', timestamp: AT(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-skill', content: 'ok' }] }
    }
    const evidence = skillsOf(parse(prompt, activation, injection, skillCall, skillResult, answer))
    expect(evidence.skills.value).toHaveLength(1)
    expect(evidence.skills.value?.[0]).toMatchObject({ id: 'call-skill', status: 'success' })
  })
})
