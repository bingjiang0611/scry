// 分段视图：把当前会话按活跃 context（baseline/skill/mcp/subagent）切段，
// ribbon 时间条 + 段账本 + 当前段证据详情（token/api/工具/文件，全真实数据）。
// 数据走 aggregateSegmentsRich（renderer 纯函数，turn 粒度归集 token）——精确 active_skill 待后端 PR#7。
import { useMemo, useState } from 'react'
import { aggregateSegmentsRich, fmtTok, resultOf } from '../format'
import type { RichSegment, Turn } from '../format'
import { Icon } from './primitives/Icon'

const KIND_CLASS: Record<RichSegment['kind'], string> = {
  baseline: 'b-base',
  skill: 'b-skill1',
  mcp: 'b-mcp',
  subagent: 'b-agent'
}
const KIND_LABEL: Record<RichSegment['kind'], string> = {
  baseline: 'baseline',
  skill: 'skill',
  mcp: 'mcp call',
  subagent: 'subagent'
}
const KIND_VAR: Record<RichSegment['kind'], string> = {
  baseline: 'var(--dim3)',
  skill: 'var(--skill)',
  mcp: 'var(--mcp)',
  subagent: 'var(--agent)'
}
function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function turnRange(s: RichSegment): string {
  return s.turnStart === s.turnEnd ? `turn ${String(s.turnStart).padStart(2, '0')}` : `turns ${String(s.turnStart).padStart(2, '0')}–${String(s.turnEnd).padStart(2, '0')}`
}

function segmentKey(segment: RichSegment): string {
  return `${segment.kind}:${segment.name}:${segment.turnStart}`
}

interface SegmentCoverage {
  turns: number
  apiKnownTurns: number
  inputKnownTurns: number
  outputKnownTurns: number
}

function coverageFor(segment: RichSegment, turns: Turn[]): SegmentCoverage {
  const results = turns.slice(segment.turnStart - 1, segment.turnEnd).map(resultOf)
  return {
    turns: results.length,
    apiKnownTurns: results.filter((result) => result?.durationApiMs != null).length,
    inputKnownTurns: results.filter((result) => result?.tokensIn != null).length,
    outputKnownTurns: results.filter((result) => result?.tokensOut != null).length
  }
}

function tokenCoverageComplete(coverage: SegmentCoverage): boolean {
  return coverage.turns > 0 && coverage.inputKnownTurns === coverage.turns && coverage.outputKnownTurns === coverage.turns
}

function fmtSegmentTokens(segment: RichSegment, coverage: SegmentCoverage): string {
  if (segment.totalTokens == null) return '—'
  return `${tokenCoverageComplete(coverage) ? '' : '≥ '}${fmtTok(segment.totalTokens)}`
}

function fmtSegmentApi(segment: RichSegment, coverage: SegmentCoverage): string {
  if (segment.apiMs == null || coverage.apiKnownTurns === 0) return '—'
  return `${coverage.apiKnownTurns < coverage.turns ? '≥ ' : ''}${fmtDur(segment.apiMs)}`
}

export function SegmentsView({ turns }: { turns: Turn[] }) {
  const rep = useMemo(() => aggregateSegmentsRich(turns), [turns])
  const { segments } = rep
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const coverage = useMemo(
    () => new Map(segments.map((segment) => [segmentKey(segment), coverageFor(segment, turns)])),
    [segments, turns]
  )

  if (segments.length === 0) {
    return (
      <main className="seg-pane">
        <div className="seg-empty">本会话还没有可切的段——发个任务后再看分段。</div>
      </main>
    )
  }

  // 摘要只比较能由当前聚合证明的 Token、API 与重复读取。
  const tokenHeaviest = [...segments]
    .filter((segment) => segment.totalTokens != null)
    .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0))[0]
  const slowest = [...segments]
    .filter((segment) => segment.apiMs != null)
    .sort((a, b) => (b.apiMs ?? 0) - (a.apiMs ?? 0))[0]
  const worst = [...segments].filter((s) => s.effFactor > 1).sort((a, b) => b.effFactor - a.effFactor)[0]
  const selectedIndex = selectedKey == null ? 0 : segments.findIndex((segment) => segmentKey(segment) === selectedKey)
  const safeSelectedIndex = selectedIndex >= 0 ? selectedIndex : 0
  const selected = segments[safeSelectedIndex]
  const selectedCoverage = coverage.get(segmentKey(selected))!
  const sessionTokenCoverageComplete = [...coverage.values()].every(tokenCoverageComplete)
  const sessionApiCoverageComplete = [...coverage.values()].every((item) => item.turns > 0 && item.apiKnownTurns === item.turns)
  const tokenPct = (s: RichSegment): number | null =>
    rep.totalTokens != null &&
    rep.totalTokens > 0 &&
    sessionTokenCoverageComplete &&
    s.totalTokens != null &&
    tokenCoverageComplete(coverage.get(segmentKey(s))!)
      ? Math.round((s.totalTokens / rep.totalTokens) * 100)
      : null
  const tokenPctLabel = (s: RichSegment): string => {
    const pct = tokenPct(s)
    return pct == null ? '—' : `${pct}%`
  }

  return (
    <main className="seg-pane">
      <header className="segments-evidence-header">
        <div><span>SEGMENTS · ACTIVE CONTEXT LEDGER</span><h2>会话切成 {segments.length} 段</h2><p>选择一个时间段，右侧只解释该段能够证明的 Token、API、工具与文件证据。</p></div>
        <strong>{rep.totalTokens == null ? '—' : `${sessionTokenCoverageComplete ? '' : '≥ '}${fmtTok(rep.totalTokens)}`} tok</strong>
      </header>

      <div className="seg-note"><Icon name="info" /> 按 turn 活跃 context 聚合；子 Agent 没有独立 usage 时不伪造归属。</div>

      <div className="segment-ribbon" role="group" aria-label="会话分段时间带">
        {segments.map((segment, index) => {
          const segmentCoverage = coverage.get(segmentKey(segment))!
          const width = sessionApiCoverageComplete
            ? segment.pct
            : ((segment.turnEnd - segment.turnStart + 1) / rep.sessionTurns) * 100
          return (
            <button
              type="button"
              key={`${segment.kind}-${segment.turnStart}-${index}`}
              className={`${KIND_CLASS[segment.kind]} ${index === safeSelectedIndex ? 'is-selected' : ''}`}
              style={{ width: `${Math.max(width, 3)}%` }}
              onClick={() => setSelectedKey(segmentKey(segment))}
              aria-pressed={index === safeSelectedIndex}
              title={`${segment.name} · ${turnRange(segment)} · API ${fmtSegmentApi(segment, segmentCoverage)}`}
            >
              {width >= 8 ? `${String(index + 1).padStart(2, '0')} · ${segment.name}` : String(index + 1).padStart(2, '0')}
            </button>
          )
        })}
      </div>

      <div className="segments-summary-strip" aria-label="分段摘要">
        <span><small>SESSION</small><b>{rep.sessionTurns} turns</b></span>
        <span><small>{sessionTokenCoverageComplete ? '最高 Token' : '最大已知下界'}</small><b>{tokenHeaviest ? `${tokenHeaviest.name} · ${sessionTokenCoverageComplete ? tokenPctLabel(tokenHeaviest) : fmtSegmentTokens(tokenHeaviest, coverage.get(segmentKey(tokenHeaviest))!)}` : '—'}</b></span>
        <span><small>{sessionApiCoverageComplete ? '最慢段' : '最长已知 API'}</small><b>{slowest ? `${slowest.name} · ${fmtSegmentApi(slowest, coverage.get(segmentKey(slowest))!)}` : '—'}</b></span>
        <span><small>结构化重读</small><b>{worst ? `${worst.name} · ${worst.repeatReads}` : '已观测 0'}</b></span>
      </div>

      <div className="segments-workspace">
        <nav className="segment-ledger" aria-label="分段账本">
          <header><span>01</span><h3>时间段</h3><small>按出现顺序</small></header>
          {segments.map((segment, index) => {
            const segmentCoverage = coverage.get(segmentKey(segment))!
            return (
              <button
                type="button"
                key={`${segment.name}-${segment.turnStart}-${index}`}
                className={index === safeSelectedIndex ? 'is-selected' : ''}
                onClick={() => setSelectedKey(segmentKey(segment))}
                aria-pressed={index === safeSelectedIndex}
              >
                <span className="segment-index">{String(index + 1).padStart(2, '0')}</span>
                <i style={{ background: KIND_VAR[segment.kind] }} aria-hidden="true" />
                <span className="segment-ledger-copy"><b>{segment.name}</b><small>{KIND_LABEL[segment.kind]} · {turnRange(segment)}</small></span>
                <span className="segment-ledger-values"><b>{fmtSegmentApi(segment, segmentCoverage)}</b><small>{fmtSegmentTokens(segment, segmentCoverage)} tok</small></span>
                <span aria-hidden="true">›</span>
              </button>
            )
          })}
        </nav>

        <article className={`segment-inspector kind-${selected.kind}`} aria-live="polite">
          <header><span>SEGMENT EVIDENCE</span><em style={{ color: KIND_VAR[selected.kind] }}><i style={{ background: KIND_VAR[selected.kind] }} />{KIND_LABEL[selected.kind]}</em></header>
          <div className="segment-inspector-title"><span>{String(safeSelectedIndex + 1).padStart(2, '0')}</span><div><h2>{selected.name}</h2><p>{turnRange(selected)} · {selectedCoverage.apiKnownTurns === 0 ? 'API 覆盖未知' : sessionApiCoverageComplete ? `${selected.pct.toFixed(0)}% 会话 API 时间` : `${selectedCoverage.apiKnownTurns}/${selectedCoverage.turns} 轮 API 已捕获；会话占比未知`}</p></div></div>
          <p className="segment-inspector-summary">
            {selected.files.length > 0 ? `结构化文件证据：${selected.files.join('、')}${selected.files.length >= 4 ? ' 等' : ''}。` : '本段没有结构化文件读写证据。'}
            {selected.dangers > 0 ? ` ${selected.dangers} 处危险操作已观测并放行。` : ''}
            {selected.effFactor > 1 ? ` 重复读 ${selected.repeatReads} 次。` : ''}
          </p>
          <div className="segment-metric-grid">
            <span><small>Token</small><b>{fmtSegmentTokens(selected, selectedCoverage)}</b><em>{selected.totalTokens == null ? 'Provider 未上报 Token · ' : tokenPct(selected) != null ? `${tokenPctLabel(selected)} 总 Token · ` : ''}输入 {selectedCoverage.inputKnownTurns}/{selectedCoverage.turns} 轮 · 输出 {selectedCoverage.outputKnownTurns}/{selectedCoverage.turns} 轮</em></span>
            <span><small>API</small><b>{fmtSegmentApi(selected, selectedCoverage)}</b><em>{selectedCoverage.apiKnownTurns}/{selectedCoverage.turns} 轮已捕获{selectedCoverage.apiKnownTurns > 0 && selectedCoverage.apiKnownTurns < selectedCoverage.turns ? ' · 已知下界' : ''}</em></span>
            <span><small>工具</small><b>{selected.tools}</b><em>{selected.errors} error</em></span>
            <span><small>文件</small><b>{[selected.reads && `${selected.reads}R`, selected.writes && `${selected.writes}W`, selected.edits && `${selected.edits}E`].filter(Boolean).join(' ') || '—'}</b><em>仅结构化文件工具</em></span>
          </div>
          <section className="segment-activity-ledger">
            <header><h3>调用证据</h3><span>{selected.acts.length} 类</span></header>
            {selected.acts.length > 0 ? selected.acts.map((activity) => (
              <div key={activity.label}><span>{activity.op ? <em className={`op ${activity.op}`}>{activity.label}</em> : activity.label}</span><i /><b>{activity.count}</b></div>
            )) : <p>当前段没有结构化调用证据。</p>}
          </section>
          <footer>TRACE AGGREGATE · UNKNOWN ≠ 0 · TOOL TOKEN ATTRIBUTION UNAVAILABLE</footer>
        </article>
      </div>
    </main>
  )
}
