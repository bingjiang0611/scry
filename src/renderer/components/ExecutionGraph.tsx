// Execution Graph 拓扑：稳定横向泳道 + 右侧 span 详情。
// Session → Turn → llm_request(message_id) → tool/skill/mcp/agent → subagent(parentToolUseId 嵌套)。
// 数据来自内存 turns（实时）。诚实：per-LLM token/cost 我们没有；latbar 用真实 durationMs，账单口径只显示 result usage token。
import {
  useMemo,
  type CSSProperties,
  type ReactNode
} from 'react'
import { mcpCallsForEvent, type TraceEvent } from '@shared/trace'
import {
  aggregateCalls,
  basename,
  fmtTok,
  fmtTokenCoverage,
  hasTokenUsage,
  parseUserMessage,
  resultOf,
  resultTokenTotal,
  toolArg,
  toolDisplayName
} from '../format'
import { logicalCallEventsForTurn } from '../../shared/logical-calls'
import type { Turn } from '../format'
import { Icon } from './primitives/Icon'
import { PaneSplitter } from './PaneSplitter'
import { useResizablePane } from '../hooks/useResizablePane'

type GraphPaneStyle = CSSProperties & {
  '--graph-detail-w': string
}

const GRAPH_DETAIL_MIN = 300
const GRAPH_DETAIL_MAX = 640
const GRAPH_DETAIL_DEFAULT = 380

const GTYPE: Record<string, { cls: string; label: string }> = {
  tool: { cls: 'tool', label: 'TOOL' },
  skill: { cls: 'skill', label: 'SKILL' },
  agent: { cls: 'agent', label: 'SUBAGENT' }
}

function fmtDur(ms?: number): string {
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function gtypeOf(ev: TraceEvent): { cls: string; label: string } {
  if (ev.isMcp) return { cls: 'mcp', label: 'MCP' }
  return GTYPE[ev.kind] ?? { cls: 'tool', label: 'TOOL' }
}

// 一行调用节点
function GLine({
  ev,
  selectedId,
  onSelect,
  maxDur
}: {
  ev: TraceEvent
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  maxDur: number
}) {
  const t = gtypeOf(ev)
  const err = ev.isError === true
  const mcpCalls = ev.isMcp ? mcpCallsForEvent(ev) : []
  const mcpServers = [...new Set(mcpCalls.map((call) => call.server))]
  const displayName = mcpCalls.length > 0 ? mcpServers.join(' · ') : toolDisplayName(ev)
  const displayArg =
    mcpCalls.length > 0
      ? `${mcpCalls.map((call) => call.action ?? call.tool).join(' · ')}${mcpCalls.length > 1 ? ` · ${mcpCalls.length} 次调用` : ''}`
      : toolArg(ev)
  const w = ev.durationMs != null && maxDur > 0 ? Math.max(2, Math.round((ev.durationMs / maxDur) * 100)) : 0
  return (
    <button
      type="button"
      className={`gline ${selectedId === ev.id ? 'selected' : ''}`}
      aria-pressed={selectedId === ev.id}
      onClick={() => onSelect(ev)}
    >
      <span className={`gtype ${t.cls} ${err ? 'err' : ''}`}>
        <span className="st" />
        {t.label}
      </span>
      <span className={`gname ${err ? 'err' : ''}`}>{displayName}</span>
      <span className="gargs">{displayArg}</span>
      <span className="gmeta">
        {w > 0 && (
          <span className="latbar">
            <i className={err ? 'bad' : ev.kind === 'agent' ? 'agent' : ''} style={{ left: 0, width: `${w}%` }} />
          </span>
        )}
        {ev.durationMs != null && <span className="dur">{fmtDur(ev.durationMs)}</span>}
        {ev.danger && (
          <span className="danger">
            <Icon name="alert" /> {ev.danger.level === 'danger' ? '高危' : '可疑'}
          </span>
        )}
      </span>
    </button>
  )
}

function TurnBlock({
  turn,
  idx,
  selectedId,
  onSelect
}: {
  turn: Turn
  idx: number
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
}) {
  // 合并 tool_result 进 tool_use（拿 isError / durationMs / output）
  const items = useMemo(() => {
    const results = new Map<string, TraceEvent>()
    for (const e of turn.items) if (e.stage === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e)
    return logicalCallEventsForTurn(turn.items)
      .filter((e) => e.stage !== 'tool_result')
      .map((e) => {
        const r = e.toolUseId ? results.get(e.toolUseId) : undefined
        return r ? { ...e, isError: r.isError ?? e.isError, output: r.text ?? e.output, durationMs: r.durationMs ?? e.durationMs } : e
      })
  }, [turn.items])

  const calls = items.filter((e) => e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent')
  const knownToolUseIds = new Set(calls.flatMap((event) => event.toolUseId ? [event.toolUseId] : []))
  const childrenByParent = useMemo(() => {
    const m = new Map<string, TraceEvent[]>()
    for (const e of calls) {
      if (!e.parentToolUseId || !knownToolUseIds.has(e.parentToolUseId)) continue
      const arr = m.get(e.parentToolUseId) ?? []
      arr.push(e)
      m.set(e.parentToolUseId, arr)
    }
    return m
  }, [calls])
  const maxDur = Math.max(1, ...calls.map((e) => e.durationMs ?? 0))

  // 顶层调用（排除 subagent 子步骤）按 message_id 分组
  const groups = useMemo(() => {
    const g: { mid: string; items: TraceEvent[] }[] = []
    for (const e of calls) {
      if (e.parentToolUseId && knownToolUseIds.has(e.parentToolUseId)) continue
      const mid = e.messageId ?? '(no-msg)'
      let grp = g.find((x) => x.mid === mid)
      if (!grp) {
        grp = { mid, items: [] }
        g.push(grp)
      }
      grp.items.push(e)
    }
    return g
  }, [calls])

  const result = resultOf(turn)
  const running = !turn.done && !turn.error
  const toolN = aggregateCalls(calls).totalCalls
  const parsedUser = parseUserMessage(turn.userText)
  const preview = parsedUser.command ?? (parsedUser.injectedSkill ? `Skill · ${parsedUser.injectedSkill}` : parsedUser.body) ?? ''

  return (
    <section className={`graph-turn-lane ${running ? 'is-running' : ''}`}>
      <header className="graph-lane-head">
        <span className="num">
          TURN {String(idx + 1).padStart(2, '0')}
        </span>
        <span className="preview">{preview || '(无预览)'}</span>
        <span className="meta">
          {result?.durationMs != null && (
            <span>
              <b>{fmtDur(result.durationMs)}</b>
            </span>
          )}
          {result && <span>{fmtTok(hasTokenUsage(result) ? resultTokenTotal(result) : null)} tok</span>}
          <span>{toolN} calls</span>
          {running ? (
            <span style={{ color: 'var(--warn)' }}>
              <span className="sdot warn" /> 运行中
            </span>
          ) : turn.error ? (
            <span style={{ color: 'var(--bad)' }}>
              <span className="sdot bad" /> 出错
            </span>
          ) : (
            <span style={{ color: 'var(--ok)' }}>
              <span className="sdot ok" /> done
            </span>
          )}
        </span>
      </header>

      {groups.length === 0 && <div className="graph-lane-empty">本轮没有结构化工具调用</div>}

      <div className="graph-lane-track">
        {groups.map((grp, gi) => (
          <div className="graph-lane-group" key={grp.mid + gi}>
            <div className="graph-llm-node">
              <span className="gtype llm"><span className="st" />LLM</span>
              <b>{grp.mid === '(no-msg)' ? 'llm_request' : grp.mid.replace(/^msg_/, '').slice(0, 14)}</b>
              <small>{aggregateCalls(grp.items).totalCalls} 个调用</small>
            </div>
            <div className="graph-call-run">
              {grp.items.map((event) => {
                const kids = event.toolUseId ? childrenByParent.get(event.toolUseId) : undefined
                return (
                  <div className="graph-call-cluster" key={event.id}>
                    <GLine ev={event} selectedId={selectedId} onSelect={onSelect} maxDur={maxDur} />
                    {kids?.length ? (
                      <div className="graph-child-run" aria-label={`${toolDisplayName(event)} 子调用`}>
                        {kids.map((child) => <GLine key={child.id} ev={child} selectedId={selectedId} onSelect={onSelect} maxDur={maxDur} />)}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function kv(label: string, value: ReactNode, color?: string): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd style={color ? { color } : undefined}>{value}</dd>
    </>
  )
}

// 右侧 span 详情面板
function GraphDetail({
  id,
  ev,
  turns,
  dangerClassification,
  onOpenInChat
}: {
  id?: string
  ev: TraceEvent | null
  turns: Turn[]
  dangerClassification: 'classified' | 'unsupported' | 'unknown'
  onOpenInChat: (ev: TraceEvent) => void
}) {
  if (!ev) {
    return (
      <aside className="gpane" id={id}>
        <div className="gp-empty">点左侧任意节点看它的 span 详情（IDS / 入参 / 结果 / 文件 op / 危险审计）。</div>
      </aside>
    )
  }
  const turnIdx = turns.findIndex((t) => t.items.some((e) => e.id === ev.id))
  const t = gtypeOf(ev)
  // read_before：同 turn 内、该事件之前是否读过同文件
  let readBefore: number | null = null
  if (ev.fileOp === 'edit' || ev.fileOp === 'write') {
    const items = turnIdx >= 0 ? turns[turnIdx].items : []
    const me = items.findIndex((e) => e.id === ev.id)
    for (let i = me - 1; i >= 0; i--) {
      if (items[i].fileOp === 'read' && items[i].filePath === ev.filePath) {
        readBefore = i
        break
      }
    }
  }
  const copy = (s: string): void => {
    navigator.clipboard?.writeText(s)
  }
  return (
    <aside className="gpane" id={id}>
      <div className="gp-h">
        <div className="breadcrumb">
          {turnIdx >= 0 && <span>TURN {String(turnIdx + 1).padStart(2, '0')}</span>}
          {ev.messageId && (
            <>
              <Icon name="chevronRight" className="chev" />
              <span>{ev.messageId.replace(/^msg_/, '').slice(0, 12)}</span>
            </>
          )}
          <Icon name="chevronRight" className="chev" />
          <b>{t.label.toLowerCase()}</b>
        </div>
        <h2>
          {toolDisplayName(ev)}
          {ev.filePath ? ` · ${basename(ev.filePath)}` : ''}
        </h2>
        <div className="subhead">
          {ev.durationMs != null && <span>{fmtDur(ev.durationMs)}</span>}
          {ev.fileOp && (
            <>
              <span style={{ color: 'var(--dim3)' }}>·</span>
              <span style={{ color: 'var(--edit)' }}>{ev.fileOp} · exact</span>
            </>
          )}
          {ev.isError && (
            <>
              <span style={{ color: 'var(--dim3)' }}>·</span>
              <span style={{ color: 'var(--bad)' }}>error</span>
            </>
          )}
        </div>
      </div>

      <div className="gp-section">
        <h4>IDS</h4>
        <dl className="kv">
          {kv('id', ev.id)}
          {kv('tool_use_id', ev.toolUseId ?? '—')}
          {kv('parent', ev.parentToolUseId ?? '—')}
          {kv('run_id', ev.runId)}
          {kv('msg_id', ev.messageId ?? '—')}
          {ev.agentId ? kv('agent_id', ev.agentId) : null}
        </dl>
      </div>

      {ev.thinking && (
        <div className="gp-section">
          <h4>THINKING</h4>
          <pre>{ev.thinking}</pre>
        </div>
      )}

      {ev.input != null && (
        <div className="gp-section">
          <h4>INPUT</h4>
          <pre>{JSON.stringify(ev.input, null, 2)}</pre>
        </div>
      )}

      {ev.output && (
        <div className="gp-section">
          <h4>OUTPUT</h4>
          <pre>{ev.output.slice(0, 6000)}</pre>
        </div>
      )}

      {ev.filePath && (
        <div className="gp-section">
          <h4>FILE OP</h4>
          <dl className="kv">
            {kv('op', ev.fileOp, 'var(--edit)')}
            {kv('path', ev.filePath)}
            {kv('source', 'exact (tool-derived)')}
            {kv('confidence', '1.0', 'var(--ok)')}
            {kv('read_before', readBefore != null ? '同轮已读' : '未先读', readBefore != null ? 'var(--ok)' : 'var(--warn)')}
          </dl>
        </div>
      )}

      <div className="gp-section">
        <h4>DANGER · AUDIT</h4>
        {ev.danger ? (
          <div style={{ font: '12px/1.5 var(--font-mono)', color: ev.danger.level === 'danger' ? 'var(--bad)' : 'var(--warn)' }}>
            <span className={`sdot ${ev.danger.level === 'danger' ? 'bad' : 'warn'}`} /> {ev.danger.reason}（观测·审计放行，不阻断）
          </div>
        ) : dangerClassification === 'classified' ? (
          <div style={{ font: '12px/1.5 var(--font-mono)', color: 'var(--ok)' }}>
            <span className="sdot ok" /> 完整分类范围内无危险标记。
          </div>
        ) : dangerClassification === 'unsupported' ? (
          <div style={{ font: '12px/1.5 var(--font-mono)', color: 'var(--dim2)' }}>
            <span className="sdot" /> 当前 Provider 未支持危险分类；未标记不等于安全。
          </div>
        ) : (
          <div style={{ font: '12px/1.5 var(--font-mono)', color: 'var(--dim2)' }}>
            <span className="sdot" /> 危险分类能力未知；未标记不等于安全。
          </div>
        )}
      </div>

      <div className="gp-section last">
        <h4>ACTIONS</h4>
        <div className="gp-actions">
          <button className="btn ghost" onClick={() => onOpenInChat(ev)}>
            在对话中打开
          </button>
          <button className="btn ghost" onClick={() => copy(ev.id)}>
            复制 span ID
          </button>
          <button className="btn ghost" onClick={() => copy(JSON.stringify(ev, null, 2))}>
            导出 JSON
          </button>
        </div>
      </div>
    </aside>
  )
}

function verdictState(turns: Turn[], busy: boolean): { cls: 'ok' | 'warn' | 'bad'; judge: string } {
  const all = turns.flatMap((t) => t.items)
  const dangerHi = all.filter((e) => e.danger?.level === 'danger' && e.stage !== 'tool_result').length
  const hasErr = all.some((e) => e.stage === 'tool_result' && e.isError) || turns.some((t) => !!t.error)
  if (busy) return { cls: 'warn', judge: `运行中 · TURN ${String(turns.length).padStart(2, '0')}` }
  if (dangerHi > 0) return { cls: 'bad', judge: `${dangerHi} 处高危操作` }
  if (hasErr) return { cls: 'warn', judge: '完成 · 有报错' }
  return { cls: 'ok', judge: '完成' }
}

export function ExecutionGraph({
  turns,
  selectedId,
  onSelect,
  busy = false,
  onOpenInChat = () => {}
}: {
  turns: Turn[]
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  busy?: boolean
  onOpenInChat?: (ev: TraceEvent) => void
}) {
  const detailPane = useResizablePane({
    id: 'graph-detail',
    defaultWidth: GRAPH_DETAIL_DEFAULT,
    min: GRAPH_DETAIL_MIN,
    max: GRAPH_DETAIL_MAX,
    side: 'right'
  })
  const selected = useMemo(
    () => turns.flatMap((t) => t.items).find((e) => e.id === selectedId) ?? null,
    [turns, selectedId]
  )
  const all = useMemo(() => turns.flatMap((t) => t.items), [turns])
  const logicalCalls = useMemo(() => turns.flatMap((turn) => logicalCallEventsForTurn(turn.items)), [turns])
  const calls = useMemo(() => aggregateCalls(logicalCalls), [logicalCalls])
  const results = turns.map(resultOf).filter((event): event is TraceEvent => event != null)
  const tokenKnownTurns = results.filter(hasTokenUsage).length
  const totalTokens = tokenKnownTurns > 0
    ? results.reduce((sum, event) => sum + (hasTokenUsage(event) ? resultTokenTotal(event) : 0), 0)
    : null
  const dangers = all.filter((e) => e.danger && e.stage !== 'tool_result')
  const graphRuntimeProvider = [...all].reverse().find((event) => event.runtimeProvider)?.runtimeProvider
  const graphProviderId = [...all].reverse().find((event) => event.providerId)?.providerId
  const dangerClassification = graphRuntimeProvider != null
    ? graphRuntimeProvider === 'claude_sdk' || graphRuntimeProvider === 'qoder_cli'
      ? 'classified'
      : 'unsupported'
    : graphProviderId === 'claude' || graphProviderId === 'qoder'
      ? 'classified'
      : graphProviderId === 'codex' || graphProviderId === 'opencode'
        ? 'unsupported'
        : 'unknown'
  const agents = calls.agents
  const v = verdictState(turns, busy)
  const toolSub = calls.tools.slice(0, 3).map((t) => `${t.name} ${t.count}`).join(' · ') || '—'
  const graphStyle: GraphPaneStyle = {
    '--graph-detail-w': `${detailPane.visibleWidth}px`
  }

  if (turns.length === 0) {
    return <div className="gempty">发个任务，这里会画出调用拓扑树。</div>
  }

  return (
    <div className="graph-pane" style={graphStyle}>
      <div className="gtree">
        <header className="graph-evidence-header">
          <div><span>TOPOLOGY · SESSION WALL</span><h2>执行拓扑</h2><p>每一行固定为一轮；选择节点只更新右侧证据，不改变几何位置。</p></div>
          <em className={v.cls}><i className={`sdot ${v.cls}`} />{v.judge}</em>
        </header>
        <section className="graph-summary-strip" aria-label="拓扑会话摘要">
          <span><small>SESSION</small><b>{turns[0]?.runId.slice(0, 14) ?? '—'}</b><em>{results.length}/{turns.length} 轮完成</em></span>
          <span className="accent"><small>Token</small><b>{fmtTokenCoverage(totalTokens, tokenKnownTurns, turns.length)}</b><em>{tokenKnownTurns}/{turns.length} 轮已捕获</em></span>
          <span><small>Calls</small><b>{calls.totalCalls}</b><em>{toolSub}</em></span>
          <span><small>Subagent</small><b>{agents.length > 0 ? agents.reduce((sum, agent) => sum + agent.count, 0) : 0}</b><em>{agents[0]?.name ?? '已观测 0'}</em></span>
          <span className={dangers.length > 0 ? (dangers.some((danger) => danger.danger!.level === 'danger') ? 'bad' : 'warn') : dangerClassification}>
            <small>危险</small>
            <b>{dangers.length > 0 ? dangers.length : dangerClassification === 'classified' ? 0 : '—'}</b>
            <em>{dangers.length > 0 ? '审计·未拦截' : dangerClassification === 'classified' ? '完整分类范围内无事件' : dangerClassification === 'unsupported' ? '分类未支持' : '能力未知'}</em>
          </span>
        </section>

        {turns.map((t, i) => (
          <TurnBlock key={t.runId} turn={t} idx={i} selectedId={selectedId} onSelect={onSelect} />
        ))}
      </div>

      <PaneSplitter
        className="graph-detail-resizer"
        label="调整拓扑详情面板宽度"
        controls="graph-detail-pane"
        min={GRAPH_DETAIL_MIN}
        max={GRAPH_DETAIL_MAX}
        value={detailPane.width}
        collapsed={detailPane.collapsed}
        active={detailPane.resizing}
        onPointerDown={detailPane.startResize}
        onKeyDown={detailPane.onKeyDown}
      />
      <GraphDetail
        id="graph-detail-pane"
        ev={selected}
        turns={turns}
        dangerClassification={dangerClassification}
        onOpenInChat={onOpenInChat}
      />
    </div>
  )
}
