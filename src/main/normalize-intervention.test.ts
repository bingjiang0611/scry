import { describe, expect, it } from 'vitest'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { parseTranscriptToTurns } from './normalize'

/**
 * 人工介入只能来自「工具请求 + 对应结果」这一对结构：
 * 问题正文来自提问工具入参，答案来自 tool_result，拒绝类型来自 Provider 明写的字段。
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

const prompt = { type: 'user', uuid: 'u-1', timestamp: AT(1), message: { role: 'user', content: '开始' } }

const askToolUse = (): unknown => ({
  type: 'assistant', uuid: 'a-1', timestamp: AT(10),
  message: {
    id: 'm-1', role: 'assistant', content: [{
      type: 'tool_use', id: 'call-ask', name: 'AskUserQuestion',
      input: { questions: [
        { header: '口径', question: '金额怎么展示？', options: [{ label: '去尾零', description: '去掉末尾零' }] },
        { header: '范围', question: '结算栏是否纳入？', options: [{ label: '纳入', description: '一起改' }] },
        { header: '开关', question: '要不要开关？', multiSelect: false, options: [{ label: '不加', description: '不加开关' }] }
      ] }
    }]
  }
})

const askResult = (content: string, toolUseResult?: Record<string, unknown>): unknown => ({
  type: 'user', uuid: 'u-2', timestamp: AT(20),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-ask', content }] },
  ...(toolUseResult ? { toolUseResult } : {})
})

const readToolUse = (): unknown => ({
  type: 'assistant', uuid: 'a-r', timestamp: AT(10),
  message: { id: 'm-r', role: 'assistant', content: [{ type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: '/repo/a.md' } }] }
})

const readResult = (isError: boolean, content: string, toolUseResult?: Record<string, unknown>): unknown => ({
  type: 'user', uuid: 'u-r', timestamp: AT(11),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-read', is_error: isError, content }] },
  ...(toolUseResult ? { toolUseResult } : {})
})

function evidenceOf(turns: ReturnType<typeof parseTranscriptToTurns>) {
  return aggregateTurnEvidence({
    userText: '开始',
    events: turns.flatMap((turn) => turn.items),
    observable: { interventions: true }
  })
}

describe('transcript 人工介入', () => {
  it('三道题分别计数并保留题目与答案', () => {
    const answers = { '金额怎么展示？': '去尾零', '结算栏是否纳入？': '纳入', '要不要开关？': '不加' }
    const turns = parse(
      prompt,
      askToolUse(),
      askResult('Your questions have been answered.', { questions: [], answers })
    )
    expect(evidenceOf(turns).interventions).toEqual({
      status: 'available',
      quality: 'exact',
      source: ['trace_events'],
      value: [{
        kind: 'clarification',
        source: 'provider_transcript_question',
        resolution: 'answered',
        request: {
          runId: 'qoder:demo:1',
          questionId: 'call-ask',
          providerId: 'qoder',
          questionKind: 'clarification',
          source: 'provider_transcript_question',
          questions: [
            { header: '口径', question: '金额怎么展示？', options: [{ label: '去尾零', description: '去掉末尾零' }], multiSelect: false },
            { header: '范围', question: '结算栏是否纳入？', options: [{ label: '纳入', description: '一起改' }], multiSelect: false },
            { header: '开关', question: '要不要开关？', options: [{ label: '不加', description: '不加开关' }], multiSelect: false }
          ]
        },
        response: { runId: 'qoder:demo:1', questionId: 'call-ask', behavior: 'answered', answers },
        openedAt: AT(10),
        closedAt: AT(20),
        durationMs: 10_000
      }]
    })
  })

  it('用户中断与宿主取消分开记，普通工具报错不生成介入', () => {
    const resolutions = (turns: ReturnType<typeof parseTranscriptToTurns>) =>
      evidenceOf(turns).interventions?.value?.map((intervention) => intervention.resolution)

    expect(resolutions(parse(prompt, readToolUse(), readResult(true,
      "The user doesn't want to proceed with this tool use.", { toolDenialKind: 'interrupted' })))).toEqual(['user_cancelled'])
    expect(resolutions(parse(prompt, readToolUse(), readResult(true,
      'Tool cancelled by host', { toolDenialKind: 'host_cancelled' })))).toEqual(['provider_cancelled'])
    expect(resolutions(parse(prompt, readToolUse(), readResult(true,
      'Error: ENOENT: no such file or directory')))).toEqual([])
    // 非拒绝结果不能被打上拒绝标记，否则文件足迹会被误判成被拒。
    const broken = parse(prompt, readToolUse(), readResult(true, 'Error: ENOENT: no such file or directory'))
    expect(broken[0]?.items.find((event) => event.stage === 'tool_result')?.runtimeMetadata?.denialResolution).toBeUndefined()
  })

  it('被拒的工具请求结果带上拒绝标记，文件足迹才能区分', () => {
    const turns = parse(prompt, readToolUse(), readResult(true,
      "The user doesn't want to proceed with this tool use.", { toolDenialKind: 'interrupted' }))
    expect(turns[0]?.items.find((event) => event.stage === 'tool_result')?.runtimeMetadata?.denialResolution)
      .toBe('user_cancelled')
    const evidence = evidenceOf(turns)
    expect(evidence.files.value).toEqual([{ path: '/repo/a.md', operation: 'read', status: 'rejected' }])
  })

  it('没有观测到答案或取消时不补介入，只标 partial 并写明原因', () => {
    const evidence = evidenceOf(parse(prompt, askToolUse(), askResult('still waiting')))
    expect(evidence.interventions).toMatchObject({ status: 'partial', quality: 'exact', value: [] })
    expect(evidence.interventions?.omissionReason).toContain('neither its answers nor a cancellation were observed')
  })

  it('提问没有任何结果时同样标 partial，不报成零次介入', () => {
    const evidence = evidenceOf(parse(prompt, askToolUse()))
    expect(evidence.interventions?.status).toBe('partial')
    expect(evidence.interventions?.omissionReason).toContain('was never closed')
  })

  it('没有可观测来源时介入证据不可用，不是精确的空列表', () => {
    const evidence = aggregateTurnEvidence({ userText: '开始', events: [] })
    expect(evidence.interventions).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })
})

describe('transcript 提问时间', () => {
  it('每轮用自己的提问行时间，后续用户输入不移动已开始的轮次', () => {
    const turns = parse(
      prompt,
      { type: 'user', uuid: 'u-3', timestamp: AT(30), message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
      { type: 'user', uuid: 'u-4', timestamp: AT(40), message: { role: 'user', content: '第二个问题' } }
    )
    expect(turns.map((turn) => [turn.userText, turn.startedAt])).toEqual([
      ['开始', AT(1)],
      ['[Request interrupted by user for tool use]', AT(30)],
      ['第二个问题', AT(40)]
    ])
  })

  it('时间戳无效时不编造起点', () => {
    const turns = parse({ type: 'user', uuid: 'u-1', timestamp: 'not-a-date', message: { role: 'user', content: '开始' } })
    expect(turns[0]?.startedAt).toBeUndefined()
  })
})
