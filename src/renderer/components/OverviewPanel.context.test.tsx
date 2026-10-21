import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { contextCompactionOf } from '../../shared/trace'
import type { Turn } from '../format'
import { OverviewPanel } from './OverviewPanel'

function sample(id: string, contextTokens: number, patch: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id, runId: 'live', ts: '2026-09-10T00:00:00Z', kind: 'harness', stage: 'context_usage',
    contextTokens, contextModel: 'ultimate', contextProvider: 'qoder',
    contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
    modelUsage: [{ model: 'ultimate', upstreamProvider: 'qoder', contextWindow: 272000 }],
    ...patch
  }
}

const compact: TraceEvent = {
  id: 'compact', runId: 'live', ts: '2026-09-10T00:00:01Z', kind: 'harness',
  stage: 'context_compaction', compaction: { trigger: 'auto', preTokens: 201600 }
}

function render(items: TraceEvent[], previous: Turn[] = []): string {
  return renderToStaticMarkup(<OverviewPanel
    turns={[...previous, { runId: 'live', userText: 'probe', items, done: false }]}
    busy sessionId="context-session" selected={null} usage={null} stats={null} onSelect={() => {}}
  />)
}

describe('OverviewPanel request-level context', () => {
  it('keeps the heading and count while removing persistent helper subtitles and footnotes', () => {
    const html = render([])
    expect(html).toContain('<strong>总览</strong>')
    expect(html).toContain('overview-session-count')
    expect(html).not.toContain('class="overview-panel-title"><div>')
    expect(html).not.toContain('当前执行</span>')
    expect(html).not.toContain('会话证据</span>')
    expect(html).not.toContain('每轮展示工具报错及其输入')
  })

  it.each<{ quality: TraceEvent['contextUsageQuality']; description: string }>([
    { quality: 'exact', description: '精确：最近一次 Provider 请求用量' },
    { quality: 'inferred', description: '推断：Provider usage 比例换算' },
    { quality: undefined, description: '旧记录：证据质量未标记' }
  ])('shows only the live token ratio while retaining $quality evidence in the tooltip', ({ quality, description }) => {
    const html = render([sample('current', 2100, { contextUsageQuality: quality })])
    // 已用量与窗口总量分开渲染以便用字级区分主次，可见文本仍是「已用 / 窗口」。
    expect(html).toContain('<div class="ctx-copy"><div class="v"><b>2.1k</b><span> / 272.0k</span></div></div>')
    expect(html).toContain(`title="上下文 · ultimate · 已占 1% · 残余 269.9k · ${description} · 随请求用量上报更新，非逐 token"`)
    expect(html).toContain('aria-label="上下文占用 1%"')
  })

  it('keeps unavailable context explicit without extra visible explanation', () => {
    const html = render([])
    expect(html).toContain('<div class="ctx-copy"><div class="v">暂无上下文数据</div></div>')
    expect(html).toContain('title="仅在 Provider 同时上报上下文占用与模型窗口时显示"')
    expect(html).not.toContain('0.0k /')
  })

  it('updates within the unfinished turn rather than retaining the previous result; does not bill samples', () => {
    const previous: Turn = {
      runId: 'old', userText: 'old', done: true,
      items: [sample('result', 100000, { stage: 'result', runId: 'old', tokensIn: 10, tokensOut: 4 })]
    }
    expect(render([], [previous])).toContain('<b>100.0k</b><span> / 272.0k</span>')
    const first = render([sample('first', 150000)], [previous])
    expect(first).toContain('<b>150.0k</b><span> / 272.0k</span>')
    const next = render([sample('first', 150000), sample('second', 201600)], [previous])
    expect(next).toContain('<b>201.6k</b><span> / 272.0k</span>')
    expect(next).toContain('随请求用量上报更新，非逐 token')
    expect(next).toContain('<strong>14</strong>')
    expect(next).not.toContain('<span>输入 / 输出</span>')
    expect(next).not.toContain('<b>100.0k</b><span> / 272.0k</span>')
  })

  it('keeps canonical context when resultOf merges several results and ignores transcript shadows', () => {
    const html = render([
      sample('result-1', 100000, { stage: 'result', tokensIn: 10 }),
      sample('result-2', 150000, { stage: 'result', tokensIn: 20 }),
      sample('shadow', 90000, { stage: 'result', text: 'transcript assistant usage', tokensIn: 30 })
    ])
    expect(html).toContain('<b>150.0k</b><span> / 272.0k</span>')
    expect(html).not.toContain('<b>90.0k</b><span> / 272.0k</span>')
  })

  it('invalidates pre-compaction usage until the next sample, then permits a decrease', () => {
    const items = [sample('first', 201600), compact]
    const afterCompact = render(items)
    expect(afterCompact).toContain('暂无上下文数据')
    expect(afterCompact).toContain('<strong class="overview-session-count">1</strong>')
    expect(render([...items, sample('after', 20000)])).toContain('<b>20.0k</b><span> / 272.0k</span>')
  })

  it('does not inherit a stale percentage when the latest model window is unknown', () => {
    expect(render([
      sample('first', 201600), sample('unknown-model', 12000, { contextModel: 'new', modelUsage: [{ model: 'new' }] })
    ])).toContain('暂无上下文数据')
  })

  it('shows zero observed compactions while retaining the loaded-record scope', () => {
    const html = render([])
    expect(html).toContain('<strong class="overview-session-count">0</strong>')
    expect(html).toContain('仅统计当前已加载记录中确认完成的压缩；不代表原生会话的全部历史')
    const summary = html.slice(html.indexOf('overview-session-summary'), html.indexOf('overview-data-tabs'))
    expect(summary).not.toContain('未观测到')
  })

  it('shortens long IDs without losing the full ID or exposing an unknown ID as a copy action', () => {
    const props = { turns: [{ runId: 'test', userText: '', items: [], done: true }], selected: null, usage: null, stats: null, onSelect: () => {} }
    const known = renderToStaticMarkup(<OverviewPanel {...props} sessionId="01a10000-1111-7000-8000-00000000abcd" />)
    expect(known).toContain('01a10000…0000abcd')
    expect(known).toContain('title="01a10000-1111-7000-8000-00000000abcd"')
    expect(known).toContain('aria-expanded="false"')
    const missing = renderToStaticMarkup(<OverviewPanel {...props} sessionId={null} />)
    expect(missing).toContain('尚未捕获')
    expect(missing).not.toContain('overview-session-id-toggle')
    expect(missing).toContain('class="overview-session-copy" disabled=""')
  })

  it('reads successful raw Pi compaction lifecycle evidence from older archives', () => {
    const legacy: TraceEvent = {
      ...compact, stage: 'compaction_end',
      runtimeMetadata: { type: 'compaction_end', reason: 'manual', aborted: false, result: { tokensBefore: 201600 } }
    }
    expect(contextCompactionOf(legacy)).toEqual({ trigger: 'manual', preTokens: 201600 })
    expect(render([sample('first', 201600), legacy])).toContain('暂无上下文数据')
    expect(render([legacy])).toContain('<strong class="overview-session-count">1</strong>')
    for (const patch of [{ aborted: true }, { result: undefined }, { errorMessage: 'failed' }]) {
      const failed = { ...legacy, runtimeMetadata: { ...legacy.runtimeMetadata, ...patch } }
      expect(contextCompactionOf(failed)).toBeNull()
      expect(render([sample('first', 201600), failed])).toContain('<b>201.6k</b><span> / 272.0k</span>')
    }
    expect(contextCompactionOf({ ...legacy, stage: 'compaction_start' })).toBeNull()
  })
})
