import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, TurnToolErrorDetails, overviewToolErrors, ev } = shared
type TraceEvent = shared.TraceEvent

const REF = {
  storage: 'recorder-content-v1' as const,
  sha256: 'a'.repeat(64),
  bytes: 1425,
  encoding: 'utf8' as const
}

const archivedContent = {
  encoding: 'utf8' as const,
  savedBytes: 0,
  source: 'scry_app_trace',
  sourceCompleteness: 'unknown' as const,
  redaction: 'disabled' as const,
  storage: 'omitted' as const,
  reasons: ['turn_budget' as const],
  contentRef: REF
}

// 真实回归：一轮正文预算用尽后，错误卡只剩归档引用；旧实现把它渲染成“Provider 未上报”。
function archivedTurnBudgetError(): { call: TraceEvent; result: TraceEvent } {
  return {
    call: ev({
      id: 'e-call', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't1',
      inputContent: { ...archivedContent, encoding: 'json', reasons: ['turn_budget'] }
    }),
    result: ev({
      id: 'e-result', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: 't1', isError: true,
      outputContent: archivedContent
    })
  }
}

function render(errors: ReturnType<typeof overviewToolErrors>, remote = false) {
  return renderToStaticMarkup(<TurnToolErrorDetails errors={errors} onOpen={() => {}} remote={remote} />)
}

describe('总览工具报错卡：完整正文按需读取', () => {
  it('正文只剩归档引用时给出可展开的读取入口，而不是 Provider 未上报', () => {
    const { call, result } = archivedTurnBudgetError()
    const html = render(overviewToolErrors([call, result]))

    expect(html).toContain('查看完整 output · 1,425 bytes')
    expect(html).toContain('查看完整 input · 1,425 bytes')
    expect(html).toContain('完整输出已存档 · 1,425 bytes')
    expect(html).not.toContain('Provider 未上报')
  })

  it('内联正文存在时直接展示原始错误证据', () => {
    const { call } = archivedTurnBudgetError()
    const html = render(overviewToolErrors([call, ev({
      id: 'e-result', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: 't1', isError: true,
      output: '{"content":[{"type":"text","text":"Command exited with code 2"}],"details":{"exitCode":2}}'
    })]))

    expect(html).toContain('Command exited with code 2')
    expect(html).not.toContain('Provider 未上报')
  })

  it('真正没有正文和引用时才显示 Provider 未上报', () => {
    const html = render(overviewToolErrors([
      ev({ id: 'e-call', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't2' }),
      ev({ id: 'e-result', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: 't2', isError: true })
    ]))

    expect(html).toContain('Provider 未上报')
    expect(html).toContain('工具未返回错误详情')
    expect(html).not.toContain('查看完整')
  })

  it('远程会话的归档引用明确标记不可在本机读取', () => {
    const { call, result } = archivedTurnBudgetError()
    const html = render(overviewToolErrors([call, result]), true)

    expect(html).toContain('远程正文引用不可在本机读取。')
    expect(html).not.toContain('查看完整 output')
  })
})
