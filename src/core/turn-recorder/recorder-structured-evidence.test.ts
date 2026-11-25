import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { listRecords, type AgentTurnRecord } from './store'

const fixture = new URL('../../../fixtures/recorder/qoder-structured-evidence.jsonl', import.meta.url)

const SESSION = 'demo-qoder-session'
let root = ''
let records: AgentTurnRecord[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry-structured-evidence-'))
  const transcript = join(root, 'qoder-session.jsonl')
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'test', capture: { diff: false } }))
  await writeFile(transcript, await readFile(fixture, 'utf8'))
  const base = { session_id: SESSION, cwd: root, transcript_path: transcript }

  expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
    ...base, request_set_id: 'R1', prompt: '整理这次需求：示例购物车需求', timestamp: '2026-11-16T08:03:18.814Z'
  } })).toMatchObject({ status: 'started' })
  expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'Stop', payload: {
    ...base, parent_request_set_id: 'R1', assistant_response: '需求已整理，等待确认。', timestamp: '2026-11-16T08:13:05.000Z'
  } })).toMatchObject({ status: 'committed' })

  expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
    ...base, request_set_id: 'R2', prompt: '看下当前采集工具的版本', timestamp: '2026-11-16T08:13:23.357Z'
  } })).toMatchObject({ status: 'started' })
  expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'Stop', payload: {
    ...base, parent_request_set_id: 'R2', assistant_response: '按你的选择继续。', timestamp: '2026-11-16T08:38:20.000Z'
  } })).toMatchObject({ status: 'committed' })

  records = await listRecords(join(root, '.scry'))
}, 60_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const first = (): AgentTurnRecord => records[0]!
const second = (): AgentTurnRecord => records[1]!

function callInput(call: { input?: unknown; inputContent?: { content?: string } }): Record<string, unknown> | undefined {
  if (call.input && typeof call.input === 'object') return call.input as Record<string, unknown>
  if (!call.inputContent?.content) return undefined
  try {
    return JSON.parse(call.inputContent.content) as Record<string, unknown>
  } catch {
    return undefined
  }
}

describe('structured evidence from a Qoder transcript', () => {
  it('按两次提问各自成界，使用真实提问时间而不是开启采集时间', () => {
    expect(records).toHaveLength(2)
    expect(first().user.value?.text).toBe('整理这次需求：示例购物车需求')
    expect(second().user.value?.text).toBe('看下当前采集工具的版本')
    expect(first().startedAt).toBe('2026-11-16T08:02:34.361Z')
    expect(second().startedAt).toBe('2026-11-16T08:13:23.357Z')
    expect(Date.parse(second().startedAt)).toBeGreaterThan(Date.parse(first().startedAt))
  })

  it('把宿主 Skill 激活与字符串形式的注入记成一条技能证据，且不进模型正文', () => {
    expect(first().skills.value).toHaveLength(1)
    expect(first().skills.value?.[0]).toMatchObject({ name: 'demo:cart-skill', category: 'skill' })
    expect(callInput(first().skills.value![0]!)).toMatchObject({
      source: 'skill_activation',
      activatedAt: '2026-11-16T08:02:34.565Z',
      injectedAt: '2026-11-16T08:02:34.628Z',
      injectedName: 'cart-skill'
    })
    expect(first().assistant.value?.text).not.toContain('activated')
    expect(second().skills.value ?? []).toEqual([])
  })

  it('从真实的工具请求/结果配对还原人工介入，三题分计并保留问答与起止', () => {
    expect(first().interventions).toMatchObject({ status: 'available', quality: 'exact' })
    const denial = first().interventions!.value![0]!
    expect(denial).toMatchObject({ kind: 'permission', resolution: 'user_cancelled' })
    expect(denial.request.questionId).toBe('call-read-1')
    expect(denial.request.questions).toEqual([{
      header: 'Read',
      question: 'Read /Users/demo/codes/run/references/page-research.md',
      options: [],
      multiSelect: false
    }])
    expect(denial.response).toEqual({ runId: denial.request.runId, questionId: 'call-read-1', behavior: 'cancelled' })
    expect(denial.openedAt).toBe('2026-11-16T08:12:40.537Z')
    expect(denial.closedAt).toBe('2026-11-16T08:12:41.049Z')
    expect(denial.durationMs).toBe(512)

    expect(second().interventions).toMatchObject({ status: 'available', quality: 'exact' })
    const question = second().interventions!.value![0]!
    expect(question).toMatchObject({ kind: 'clarification', resolution: 'answered' })
    expect(question.request.questions).toHaveLength(3)
    expect(question.openedAt).toBe('2026-11-16T08:33:24.378Z')
    expect(question.closedAt).toBe('2026-11-16T08:38:16.025Z')
    expect(question.durationMs).toBe(291_647)
    expect(question.response).toMatchObject({
      behavior: 'answered',
      answers: {
        '含小数的金额本期怎么展示？': '一并去尾零（推荐）',
        '结算栏提示金额是否纳入本期？': '纳入，一起改（推荐）',
        '本次展示变化是否要求开关灰度？': '不加开关（推荐）'
      }
    })
  })

  it('人工等待与工具执行时间分开：提问/被拒的调用标出等待，执行调用不陪同', () => {
    const ask = second().tools.value?.find(call => call.name === 'AskUserQuestion')
    expect(ask?.humanInterventionId).toBe('call-ask-1')
    expect(ask?.durationMs).toBe(291_647)
    const deniedRead = first().tools.value?.find(call => call.id === 'call-read-1')
    expect(deniedRead?.humanInterventionId).toBe('call-read-1')
    const executed = first().tools.value?.find(call => call.id === 'call-bash-1')
    expect(executed?.humanInterventionId).toBeUndefined()
    expect(executed?.durationMs).toBe(500)
  })

  it('Hook 失败逐次保留关联 ID、原始退出码、耗时与错误正文，不因命令里的 || true 记成成功', () => {
    const hooks = first().hooks.value ?? []
    expect(hooks).toHaveLength(2)
    expect(hooks.map(hook => [hook.event, hook.name, hook.id, hook.exitCode, hook.durationMs, hook.status])).toEqual([
      ['PreToolUse', 'PreToolUse:Bash', 'call-bash-1', -1, 0, 'failed'],
      ['PostToolUse', 'PostToolUse:Bash', 'call-bash-1', -1, 5004, 'failed']
    ])
    expect(hooks[0]?.command).toContain('scry-gate PreToolUse qoder || true')
    expect(hooks[0]?.error).toBe('Failed with non-blocking status code: No stderr output')
    expect(hooks[1]?.error).toBe('Failed with non-blocking status code: Hook timed out after 5s')
    expect(hooks.every(hook => !('timedOut' in hook))).toBe(true)
    expect(second().hooks.value ?? []).toEqual([])
  })

  it('被拒的读取不算已读，同一操作的其它成功不会被抹掉', () => {
    expect(first().files.value).toEqual([
      { path: '/Users/demo/codes/run/references/page-research.md', operation: 'read', status: 'rejected' }
    ])
    expect(first().tools.value?.map(call => call.name)).toEqual(['Bash', 'Read'])
    expect(second().tools.value?.map(call => call.name)).toEqual(['AskUserQuestion'])
  })
})
