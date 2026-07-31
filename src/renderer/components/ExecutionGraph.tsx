// Execution Graph 拓扑（蓝本 graph.html）：full verdict 卡 + latency 节点树 + 右侧 span 详情。
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
  parseUserMessage,
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
  const childrenByParent = useMemo(() => {
    const m = new Map<string, TraceEvent[]>()
    for (const e of calls) {
      if (!e.parentToolUseId) continue
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
      if (e.parentToolUseId) continue
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

  const result = turn.items.find((e) => e.kind === 'harness' && e.stage === 'result')
  const running = !turn.done && !turn.error
  const toolN = aggregateCalls(calls).totalCalls
  const parsedUser = parseUserMessage(turn.userText)
  const preview = parsedUser.command ?? (parsedUser.injectedSkill ? `Skill · ${parsedUser.injectedSkill}` : parsedUser.body) ?? ''

  return (
    <div className="turn-block">
      <div className={`turn-head ${running ? 'running' : ''}`}>
        <span className="num">
          <span className="turn-toggle" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
          TURN {String(idx + 1).padStart(2, '0')}
        </span>
        <span className="preview">{preview || '(无预览)'}</span>
        <span className="meta">
          {result?.durationMs != null && (
            <span>
              <b>{fmtDur(result.durationMs)}</b>
            </span>
          )}
          {result && <span>{fmtTok(resultTokenTotal(result))} tok</span>}
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
      </div>

      {groups.length === 0 && <div className="gempty" style={{ padding: '8px 20px', textAlign: 'left' }}>（本轮无工具调用）</div>}

      {groups.map((grp, gi) => (
        <div key={grp.mid + gi}>
          <div className="gnode depth-0">
            <div className="gutter" />
            <div className="gcontent">
              <div className="gline" style={{ cursor: 'default' }}>
                <span className="gtype llm">
                  <span className="st" />
                  LLM
                </span>
                <span className="gname">{grp.mid === '(no-msg)' ? 'llm_request' : grp.mid.replace(/^msg_/, '').slice(0, 14)}</span>
                <span className="gargs">{aggregateCalls(grp.items).totalCalls} 个调用</span>
              </div>
            </div>
          </div>
          {grp.items.map((e, ei) => {
            const kids = e.toolUseId ? childrenByParent.get(e.toolUseId) : undefined
            const last = ei === grp.items.length - 1 && !kids?.length
            return (
              <div key={e.id}>
                <div className={`gnode ${last ? 'last' : ''}`}>
                  <div className="gutter" />
                  <div className="gcontent">
                    <GLine ev={e} selectedId={selectedId} onSelect={onSelect} maxDur={maxDur} />
                  </div>
                </div>
                {kids?.map((k, ki) => (
                  <div className={`gnode sub ${ki === kids.length - 1 ? 'last' : ''}`} key={k.id}>
                    <div className="gutter" />
                    <div className="gcontent">
                      <GLine ev={k} selectedId={selectedId} onSelect={onSelect} maxDur={maxDur} />
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      ))}
    </div>
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
  onOpenInChat
}: {
  id?: string
  ev: TraceEvent | null
  turns: Turn[]
  onOpenInChat: () => void
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
        ) : (
          <div style={{ font: '12px/1.5 var(--font-mono)', color: 'var(--ok)' }}>
            <span className="sdot ok" /> 无危险标记。
          </div>
        )}
      </div>

      <div className="gp-section last">
        <h4>ACTIONS</h4>
        <div className="gp-actions">
          <button className="btn ghost" onClick={onOpenInChat}>
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
  onOpenInChat?: () => void
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
  const results = all.filter((e) => e.kind === 'harness' && e.stage === 'result')
  const totalTokens = results.reduce((sum, event) => sum + resultTokenTotal(event), 0)
  const dangers = all.filter((e) => e.danger && e.stage !== 'tool_result')
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
        <div className={`verdict-card full ${v.cls}`}>
          <div className="verdict-left">
            <div className="lbl">SESSION · {turns[0]?.runId.slice(0, 14) ?? '—'}</div>
            <div className={`judgement ${v.cls}`}>
              <span className={`sdot ${v.cls}`} style={{ width: 10, height: 10 }} />
              {v.judge}
            </div>
            <div className="since">
              {results.length} 轮完成 · {calls.totalCalls} 次调用{dangers.length > 0 ? ` · ${dangers.length} 处危险` : ''}
            </div>
          </div>
          <div className="verdict-right">
            <div className="verdict-pillar accent">
              <div className="nm">
                <span className="sdot" />
                token · so far
              </div>
              <div className="v">{fmtTok(totalTokens)}</div>
              <div className="sub">{turns.length} turns</div>
            </div>
            <div className="verdict-pillar ok">
              <div className="nm">
                <span className="sdot" />
                calls
              </div>
              <div className="v">{calls.totalCalls}</div>
              <div className="sub">{toolSub}</div>
            </div>
            <div className="verdict-pillar ok">
              <div className="nm">
                <span className="sdot" />
                subagent
              </div>
              <div className="v">{agents.length > 0 ? `${agents.reduce((s, a) => s + a.count, 0)} · ${agents[0].name}` : '0'}</div>
              <div className="sub">{agents.length > 0 ? 'parent 链已挂' : '无'}</div>
            </div>
            <div className={`verdict-pillar ${dangers.some((d) => d.danger!.level === 'danger') ? 'bad' : dangers.length ? 'warn' : ''}`}>
              <div className="nm">
                <span className="sdot" />
                危险
              </div>
              <div className="v">{dangers.length}</div>
              <div className="sub">{dangers.length > 0 ? '审计·未拦截' : '无'}</div>
            </div>
          </div>
        </div>

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
      <GraphDetail id="graph-detail-pane" ev={selected} turns={turns} onOpenInChat={onOpenInChat} />
    </div>
  )
}
