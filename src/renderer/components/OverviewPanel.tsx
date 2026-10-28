// 右栏纵览：会话 verdict 卡 + context 占用 + 每轮调用 + 文件与 diff 证据。
import { memo, useId, useState, type CSSProperties, type MouseEvent } from 'react'
import { useSampledTurns } from '../hooks/useSampledTurns'
import type { TraceEvent, DbStats, WorkspaceDiffResult } from '@shared/trace'
import type { RuntimeProvider } from '@shared/runtime'
import { fmtTok } from '../format'
import type { Turn } from '../format'
import { OVERVIEW_COST_COPY, OVERVIEW_SESSION_COPY } from '../constants/copy'
import { Icon } from './primitives/Icon'
import { OverviewSessionPanel } from './OverviewSessionPanel'
import { OverviewTurnCalls } from './OverviewTurnCalls'
import { useOverviewPanelModel } from './overview-panel-model'
// 拆分后仍由此模块对外提供原来的公开面，避免调用方与测试四处追新路径。
export { TurnToolErrorDetails, overviewToolErrors } from './OverviewToolErrors'
export type { OverviewToolError } from './OverviewToolErrors'
export { TurnFileFootprint } from './OverviewTurnCalls'
export { turnCallRowsFromMap } from './overview-turn-calls'
export { logicalCallEventsForTurn } from '../format'

// TOP TOOLS 排名：合并普通工具 + MCP（按 server 汇总），取前 6，配 mini-bar。
// 纯组件内聚合，不动 format.ts 的聚合函数（那些有测试，面板没有）。

function formatOverviewCost(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function formatOverviewCredits(value: number): string {
  if (value > 0 && value < 0.01) return '<0.01'
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function OverviewSessionSummary({ sessionId, compactions }: { sessionId: string | null; compactions: number }) {
  const [expanded, setExpanded] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [scopeDismissed, setScopeDismissed] = useState(false)
  const scopeId = useId()
  const fullId = useId()
  const shortId = sessionId && sessionId.length > 17 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-8)}` : sessionId
  const copy = OVERVIEW_SESSION_COPY

  return (
    <section className="panel-section overview-session-summary">
      <div className="overview-session-head">
        <h4>{copy.heading}</h4>
        <div className="overview-session-compact">
          <span>{copy.compact}</span>
          <span className="overview-session-scope" data-dismissed={scopeDismissed ? '' : undefined} onMouseEnter={() => setScopeDismissed(false)} onFocus={() => setScopeDismissed(false)} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setScopeDismissed(true)
              event.stopPropagation()
            }
          }}>
            <button type="button" aria-label={copy.scopeLabel} aria-describedby={scopeId}><Icon name="info" /></button>
            <span id={scopeId} role="tooltip">{copy.scope}</span>
          </span>
          <strong className="overview-session-count">{compactions}</strong>
        </div>
      </div>
      <div className="overview-session-identity">
        <span>{copy.id}</span>
        {sessionId ? (
          <button type="button" className="overview-session-id-toggle" title={sessionId} aria-label={expanded ? copy.collapseId : copy.expandId} aria-expanded={expanded} aria-controls={fullId} onClick={() => setExpanded(!expanded)}>
            <code>{shortId}</code>
          </button>
        ) : <span className="overview-session-missing">{copy.missingId}</span>}
        <button type="button" className="overview-session-copy" disabled={!sessionId} aria-label={copy.copy} title={copy.copy} onClick={() => {
          if (sessionId) void window.scry.copyText(sessionId).then(() => setCopyStatus('copied')).catch(() => setCopyStatus('failed'))
        }}><Icon name={copyStatus === 'copied' ? 'check' : 'copy'} /></button>
      </div>
      <div id={fullId} className="overview-session-full-id" hidden={!expanded}><code>{sessionId}</code></div>
      {copyStatus !== 'idle' && <div className="overview-session-notice" role={copyStatus === 'failed' ? 'alert' : 'status'}>{copyStatus === 'copied' ? copy.copied : copy.copyFailed}</div>}
    </section>
  )
}

export interface OverviewPanelProps {
  turns: Turn[]
  sessionId?: string | null
  selected: TraceEvent | null
  usage: { cost: number | null; tin: number | null; tout: number | null; turns: number } | null
  stats: DbStats | null
  runtimeProvider?: RuntimeProvider
  gitDiff?: WorkspaceDiffResult | null
  gitDiffRefreshing?: boolean
  busy?: boolean
  /** 远端会话的正文引用不能在本机读取，不得假装可展开。 */
  remote?: boolean
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  onOpenSessionDiff?: (path?: string) => void
}

export function OverviewPanel(props: OverviewPanelProps) {
  const sessionId = props.sessionId ?? null
  const turns = useSampledTurns(props.turns, sessionId, props.busy ?? false)
  return <MemoOverviewPanelBody {...props} sessionId={sessionId} turns={turns} />
}

function OverviewPanelBody({
  turns,
  sessionId = null,
  selected,
  runtimeProvider,
  gitDiff,
  gitDiffRefreshing = false,
  busy = false,
  remote = false,
  onSelect,
  onOpenTurn,
  onOpenSessionDiff
}: OverviewPanelProps) {
  const [filesFolded, setFilesFolded] = useState(false)
  const [overviewDataTab, setOverviewDataTab] = useState<'turns' | 'session'>('turns')
  const [expandedTurnCallGroups, setExpandedTurnCallGroups] = useState<Set<string>>(() => new Set())
  const model = useOverviewPanelModel({ turns, runtimeProvider, busy, gitDiff })
  const {
    all,
    compactions,
    results,
    cost,
    cacheHit,
    isQoder,
    qoderCredits,
    qoderCreditKnown,
    qoderCreditPartial,
    ctx,
    contextDescription,
    calls,
    turnCallRows,
    billing,
    billingTokenText,
    vstate,
    judge,
  } = useOverviewPanelModel({ turns, runtimeProvider, busy, gitDiff })

  // 点调用/文件行 → 选中第一条匹配事件（右下「详情」展开它的入参/结果/文件，定位到那次调用）
  const jumpTo = (pred: (e: TraceEvent) => boolean): void => {
    const ev = all.find(pred)
    if (ev) onSelect(ev)
  }
  const toggleTurnCallGroup = (key: string, ev: MouseEvent<HTMLButtonElement>): void => {
    ev.preventDefault()
    ev.stopPropagation()
    setExpandedTurnCallGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return (
    <aside className="panel overview-dossier" data-screen-label="总览 · 当前会话证据" aria-label="当前执行总览">
      <div className="ov-topbar">
        <div className="overview-panel-title">
          <strong>总览</strong>
          <em><i aria-hidden="true" />本机真实数据</em>
        </div>
      </div>
      <div className="ov-scroll overview-scroll-content">

      {(
        <div className={`ctx-gauge ${ctx ? (ctx.pct >= 80 ? 'hot' : ctx.pct >= 50 ? 'warm' : '') : 'empty'}`} title={contextDescription}>
          <div className="ctx-head">
            <span>{OVERVIEW_SESSION_COPY.context}</span>
            <b>{ctx ? `${ctx.pct}%` : '—'}</b>
          </div>
          {/* 占用用横向刻度表达：长度比环直接可比，高度也回到一行。 */}
          <div
            className="ctx-track"
            role="img"
            style={ctx ? ({ '--p': Math.min(ctx.pct, 100) } as CSSProperties) : undefined}
            aria-label={ctx ? `上下文占用 ${ctx.pct}%` : '暂无上下文占用数据'}
          >
            {ctx && <span />}
          </div>
          <div className="ctx-copy">
            {/* 显示用量是主证据，窗口总量是参照：同一行内用字级区分，文本内容保持原样。 */}
            <div className="v">{ctx
              ? <><b>{fmtTok(ctx.used)}</b><span> / {fmtTok(ctx.win)}</span></>
              : OVERVIEW_SESSION_COPY.contextUnavailable}</div>
          </div>
        </div>
      )}

      {turns.length > 0 && (
        <section className={`overview-verdict ${vstate}`} aria-label="当前会话判词与尺度">
          <header className="overview-verdict-line">
            <div>
              <span className={`sdot ${vstate}`} />
              <strong>{judge}</strong>
            </div>
            <em>{calls.totalCalls} calls</em>
          </header>
          <div className="overview-metric-grid">
            <div className="overview-metric accent lead">
              <span>{billing.tokenFormulaLabel}</span>
              <strong>{billingTokenText}</strong>
            </div>
            <div
              className={`overview-metric ${cacheHit.rate == null ? 'unsupported' : ''}`}
              title={cacheHit.rate == null
                ? '没有完整的输入与缓存 Token 证据，无法计算命中率'
                : `缓存读取 Token ÷ 可缓存输入 Token；${cacheHit.knownResults}/${results.length} 轮可计算`}
            >
              <span>缓存命中率{cacheHit.missingResults > 0 ? ' · 部分' : ''}</span>
              <strong>{cacheHit.rate == null ? '—' : `${cacheHit.rate.toFixed(1)}%`}</strong>
            </div>
            <div
              className={`overview-metric ${isQoder ? (qoderCreditKnown ? 'accent' : 'unsupported') : cost.value == null ? 'unsupported' : ''}`}
              title={isQoder
                ? qoderCreditKnown ? `仅统计已观测到的主会话请求 Credit${qoderCreditPartial ? '，存在未覆盖请求或轮次' : ''}` : '当前会话没有可用的 Qoder Credit 证据'
                : cost.value == null ? OVERVIEW_COST_COPY.unavailable : OVERVIEW_COST_COPY.coverage(cost.known, results.length)}
            >
              <span>{isQoder ? 'Credit' : OVERVIEW_COST_COPY.label}</span>
              <strong>{isQoder
                ? qoderCreditKnown ? `${qoderCreditPartial ? '≥' : ''}${formatOverviewCredits(qoderCredits)}` : '—'
                : cost.value == null ? '—' : formatOverviewCost(cost.value)}</strong>
            </div>
          </div>
        </section>
      )}

      {turns.length > 0 && (
        <OverviewSessionSummary key={sessionId} sessionId={sessionId} compactions={compactions.length} />
      )}

      {turns.length > 0 && (
        <div className="overview-data-tabs" role="tablist" aria-label="纵览数据维度">
          <button
            type="button"
            id="overview-turns-tab"
            role="tab"
            aria-selected={overviewDataTab === 'turns'}
            aria-controls="overview-turns-panel"
            className={overviewDataTab === 'turns' ? 'active' : ''}
            onClick={() => setOverviewDataTab('turns')}
          >
            轮次数据
          </button>
          <button
            type="button"
            id="overview-session-tab"
            role="tab"
            aria-selected={overviewDataTab === 'session'}
            aria-controls="overview-session-panel"
            className={overviewDataTab === 'session' ? 'active' : ''}
            onClick={() => setOverviewDataTab('session')}
          >
            会话数据
          </button>
        </div>
      )}

      {(
        <div
          id="overview-turns-panel"
          role="tabpanel"
          aria-labelledby="overview-turns-tab"
          hidden={overviewDataTab !== 'turns'}
        >
      {turnCallRows.length > 0 && (
        <OverviewTurnCalls
          rows={turnCallRows}
          expanded={expandedTurnCallGroups}
          onToggle={toggleTurnCallGroup}
          selected={selected}
          onSelect={onSelect}
          onOpenTurn={onOpenTurn}
          remote={remote}
        />
      )}
        </div>
      )}

      {(
        <div
          id="overview-session-panel"
          role="tabpanel"
          aria-labelledby="overview-session-tab"
          hidden={overviewDataTab !== 'session'}
        >
          <OverviewSessionPanel
            model={model}
            filesFolded={filesFolded}
            onToggleFiles={() => setFilesFolded((v) => !v)}
            jumpTo={jumpTo}
            onSelect={onSelect}
            onOpenTurn={onOpenTurn}
            onOpenSessionDiff={onOpenSessionDiff}
            gitDiff={gitDiff}
            gitDiffRefreshing={gitDiffRefreshing}
          />
        </div>
      )}

      </div>
    </aside>
  )
}

const MemoOverviewPanelBody = memo(OverviewPanelBody)
