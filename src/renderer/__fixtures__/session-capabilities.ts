import { normalizeSdkMessage, type NormalizeCtx } from '../../main/normalize'
import type { Turn } from '../format'

// Sanitized reproduction of Qoder's SDK-shaped Read + tool_result stream. In particular,
// the response carries only tool_use_id; the normalizer, not the fixture, restores identity.
export function qoderSkillSessionFixture(runId = 'fixture-run', outcome: 'pending' | 'success' | 'failed' = 'success'): Turn {
  let sequence = 0
  const ctx: NormalizeCtx = {
    runId, cwd: '/fixture/rate-native', newId: () => `${runId}:${++sequence}`,
    now: () => '2026-09-08T00:00:00.000Z', toolUseById: new Map()
  }
  const wire: unknown[] = [{
    type: 'assistant', message: { id: 'assistant-1', content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/fixture/rate-native/.claude/skills/hsf-invoke/SKILL.md' } },
      { type: 'tool_use', id: 'mcp-1', name: 'mcp__browser__navigate', input: { url: 'https://example.test' } }
    ] }
  }]
  if (outcome !== 'pending') wire.push({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read-1', is_error: outcome === 'failed', content: outcome === 'success' ? '---\nname: hsf-invoke\n---\n# hsf-invoke' : 'File not found' },
      { type: 'tool_result', tool_use_id: 'mcp-1', is_error: false, content: 'ok' }
    ] }
  })
  const items = wire.flatMap((message) => normalizeSdkMessage(message, ctx)).map((event) => ({
    ...event, providerId: 'qoder' as const, runtimeProvider: 'qoder_cli' as const
  }))
  return { runId, userText: '/rate-native-hsf-invoke 查询接口', items, done: outcome !== 'pending' }
}
