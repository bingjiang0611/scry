// Diagnostics 全屏视图（蓝本 diagnostics.html）：系统判决 + 运行环境 + 安全审计 + 覆盖盲点。
// 诚实红线：scry 的 P3 是**观测不拦截**——审计日志按级别(danger/warn)统计并标"审计放行·未拦截"，
// node/electron/db 大小 renderer 拿不到 → 用真实替代或诚实标注，不编。
import { useMemo } from 'react'
import type { DbStats, Diagnostics, McpLiveStatus, TraceEvent } from '@shared/trace'
import type { DetectedAgent, McpMeta, ProjectMeta } from '../env'
import { fmtTok, toolArg } from '../format'
import type { Turn } from '../format'
import { Icon } from './primitives/Icon'

interface RuntimeCapabilityWarningView {
  kind: string
  runtimeProvider: string
  name: string
  reason: string
  expected?: string
  observed?: string
  evidence?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function runtimeWarningsFromTurns(turns: Turn[]): RuntimeCapabilityWarningView[] {
  const seen = new Set<string>()
  const warnings: RuntimeCapabilityWarningView[] = []
  for (const turn of turns) {
    for (const item of turn.items) {
      const raw = item.runtimeMetadata?.capabilityWarnings
      if (item.kind !== 'harness' || item.stage !== 'result' || !Array.isArray(raw)) continue
      for (const value of raw) {
        if (!isRecord(value)) continue
        const name = typeof value.name === 'string' ? value.name : ''
        const reason = typeof value.reason === 'string' ? value.reason : ''
        if (!name || !reason) continue
        const warning: RuntimeCapabilityWarningView = {
          kind: typeof value.kind === 'string' ? value.kind : 'capability',
          runtimeProvider:
            typeof value.runtimeProvider === 'string'
              ? value.runtimeProvider
              : typeof item.runtimeProvider === 'string'
                ? item.runtimeProvider
                : 'runtime',
          name,
          reason,
          expected: typeof value.expected === 'string' ? value.expected : undefined,
          observed: typeof value.observed === 'string' ? value.observed : undefined,
          evidence: typeof value.evidence === 'string' ? value.evidence : undefined
        }
        const key = `${warning.runtimeProvider}:${warning.kind}:${warning.name}:${warning.observed ?? ''}:${warning.reason}`
        if (seen.has(key)) continue
        seen.add(key)
        warnings.push(warning)
      }
    }
  }
  return warnings
}

export function DiagnosticsView({
  agents,
  diag,
  mcpLive,
  mcps,
  stats,
  turns,
  projects,
  usage,
  onReprobe
}: {
  agents: DetectedAgent[]
  diag: Diagnostics | null
  mcpLive: McpLiveStatus[]
  mcps: McpMeta[]
  stats: DbStats | null
  turns: Turn[]
  projects: ProjectMeta[]
  usage: { cost: number | null; tin: number | null; tout: number | null; turns: number } | null
  onReprobe: () => void
}) {
  const mcpTotal = Math.max(mcpLive.length, mcps.length)
  const mcpUp = mcpLive.filter((l) => l.status === 'connected').length
  const mcpBad = mcpLive.filter((l) => l.status === 'failed' || l.status === 'needs-auth')
  const mcpPending = mcpLive.filter((l) => l.status === 'pending')
  const mcpDisabled = mcpLive.filter((l) => l.status === 'disabled').length
  const mcpKnown = mcpLive.length > 0
  const mcpUnknown = mcps.length > 0 && !mcpKnown
  const mcpPartial = mcpLive.length > 0 && mcps.length > mcpLive.length
  const sessionCount = projects.reduce((s, p) => s + p.sessions.length, 0)
  // 危险审计（观测，不拦截）：本会话 danger 标记 + 跨会话趋势
  const sessionDangers = useMemo(
    () => turns.flatMap((t) => t.items).filter((e) => e.danger && e.stage !== 'tool_result'),
    [turns]
  )
  const runtimeWarnings = useMemo(() => runtimeWarningsFromTurns(turns), [turns])
  const trend = stats?.dangerTrend ?? []
  const trendHi = trend.filter((d) => d.level === 'danger').reduce((s, d) => s + d.n, 0)
  const trendWarn = trend.filter((d) => d.level === 'warn').reduce((s, d) => s + d.n, 0)
  const trendTotal = trendHi + trendWarn

  const mcpNeedsProbe = mcpBad.length > 0 || mcpPending.length > 0 || mcpUnknown || mcpPartial
  const mcpAttentionCount = mcpBad.length + mcpPending.length + (mcpUnknown || mcpPartial ? 1 : 0)
  const runtimeNeedsAttention = runtimeWarnings.length > 0
  const attentionCount = mcpAttentionCount + runtimeWarnings.length
  const firstRuntimeWarning = runtimeWarnings[0]
  const firstRuntimeWarningLabel = firstRuntimeWarning
    ? `${firstRuntimeWarning.runtimeProvider} ${firstRuntimeWarning.name} ${firstRuntimeWarning.observed ?? firstRuntimeWarning.reason}`
    : 'CLI runtime capability 未报告异常'
  const vstate: 'ok' | 'warn' | 'bad' = agents.length === 0 ? 'bad' : mcpNeedsProbe || runtimeNeedsAttention ? 'warn' : 'ok'
  let judge = '运行正常'
  let since = '环境探测正常 · app launch 时捕获'
  if (agents.length === 0) {
    judge = '未检测到 Provider'
    since = 'PATH 中未找到已注册的 Agent executable'
  } else if (mcpNeedsProbe || runtimeNeedsAttention) {
    judge = `运行 · ${attentionCount} 项需关注`
    if (mcpBad.length > 0) since = `MCP ${mcpBad.map((m) => m.name).join(' / ')} 需重连`
    else if (mcpPending.length > 0) since = `MCP ${mcpPending.map((m) => m.name).join(' / ')} 状态待收敛`
    else if (mcpUnknown) since = 'MCP 配置已发现，但真实连接状态尚未探测'
    else if (mcpPartial) since = '部分 MCP 配置尚未拿到真实连接状态'
    else since = firstRuntimeWarningLabel
  } else if (!diag) {
    judge = '等待诊断探测'
    since = '诊断 IPC 尚未返回；可点重新探测'
  }
  const mcpVerdictValue =
    mcpBad.length > 0
      ? `${mcpBad[0].name} ${mcpBad[0].status}`
      : mcpPending.length > 0
        ? `${mcpPending[0].name} pending`
        : mcpUnknown
          ? '状态待探测'
          : mcpPartial
            ? `${mcpUp}/${mcpTotal} known`
            : mcpTotal === 0
              ? '未配置'
              : mcpDisabled > 0
                ? `${mcpUp} connected · ${mcpDisabled} disabled`
                : `${mcpUp}/${mcpTotal} connected`
  const mcpVerdictSub =
    mcpBad.length > 0
      ? '去 MCP 面板重连'
      : mcpPending.length > 0
        ? '等待 SDK init 收敛'
        : mcpUnknown
          ? '点重新探测获取真实状态'
          : mcpPartial
            ? '点重新探测补齐状态'
            : mcpTotal === 0
              ? '没有 MCP 配置'
              : '来自 SDK init 真实状态'

  const auditRow = (ev: TraceEvent): React.ReactNode => (
    <div className="d-audit-row" key={ev.id}>
      <span className={`lvl ${ev.danger!.level === 'danger' ? 'danger' : 'warn'}`}>
        {ev.danger!.level === 'danger' ? '高危' : '可疑'}
      </span>
      <span className="what">
        {ev.tool ?? ev.name} <span className="arg">{toolArg(ev)}</span>
      </span>
      <span className="reason">{ev.danger!.reason}</span>
      <span className="action">观测放行</span>
    </div>
  )

  return (
    <main className="d-pane">
      <div className="d-hero">
        <div>
          <h2>诊断</h2>
          <div className="sub">Agent、MCP、SQLite 与安全审计；运行异常先看这里</div>
        </div>
        <div className="right">
          <button className="btn" onClick={onReprobe}>
            <Icon name="refresh" /> 重新探测
          </button>
        </div>
      </div>

      <div className="d-content">
        {/* System verdict */}
        <div className="d-verdict-wrap">
          <div className={`verdict-card full ${vstate}`}>
            <div className="verdict-left">
              <div className="lbl">系统状态</div>
              <div className={`judgement ${vstate}`}>
                <span className={`sdot ${vstate}`} style={{ width: 10, height: 10 }} />
                {judge}
              </div>
              <div className="since">
                {since}
              </div>
            </div>
            <div className="verdict-right">
              <div className={`verdict-pillar ${agents.length ? 'ok' : 'bad'}`}>
                <div className="nm">
                  <span className="sdot" />
                  Agent 环境
                </div>
                <div className="v">{agents.length ? `${agents.length} 个 Provider` : '未检测'}</div>
                <div className="sub">{agents.map((agent) => agent.name).join(' · ') || '—'}</div>
              </div>
              <div className={`verdict-pillar ${mcpNeedsProbe ? 'warn' : mcpTotal > 0 ? 'ok' : ''}`}>
                <div className="nm">
                  <span className="sdot" />
                  MCP · {mcpUp}/{mcpTotal} 在线
                </div>
                <div className="v">{mcpVerdictValue}</div>
                <div className="sub">{mcpVerdictSub}</div>
              </div>
              <div className="verdict-pillar">
                <div className="nm">
                  <span className="sdot" />
                  记录账本
                </div>
                <div className="v">{usage?.turns ?? stats?.totals.turns ?? 0} 轮</div>
                <div className="sub">
                  {sessionCount} 会话 · db 健康未暴露
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="d-grid">
          {/* LEFT */}
          <div className="col">
            <div className="d-card">
              <div className="h">
                <h3>运行环境</h3>
                <span className="sub">App 启动时探测</span>
              </div>
              <div className="b">
                {agents.map((agent) => (
                  <div className="d-row" key={agent.id}>
                    <span className="k">{agent.name}</span>
                    <span className="v path" title={agent.path}>{agent.path}</span>
                    <span className="badge">
                      <span className={`sdot ${agent.health?.state === 'degraded' ? 'warn' : 'ok'}`} />
                      {agent.version ?? agent.transport ?? 'ready'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="d-card">
              <div className="h">
                <h3>账本与用量</h3>
                <span className="sub">better-sqlite3 · WAL · 跨会话统计源（健康状态未暴露给 renderer）</span>
              </div>
              <div className="d-stat-row">
                <div className="d-stat">
                  <div className="lbl">会话</div>
                  <div className="val">{sessionCount}</div>
                </div>
                <div className="d-stat">
                  <div className="lbl">轮次</div>
                  <div className="val">{usage?.turns ?? 0}</div>
                </div>
                <div className="d-stat">
                  <div className="lbl">工具类型</div>
                  <div className="val">{stats?.topTools.length ?? 0}</div>
                </div>
                <div className="d-stat">
                  <div className="lbl">累计 token</div>
                  <div className="val" style={{ color: 'var(--accent)' }}>
                    {fmtTok((usage?.tin ?? 0) + (usage?.tout ?? 0))}
                  </div>
                </div>
              </div>
              <div className="d-row">
                <span className="k">Native ABI</span>
                <span className="v warn">renderer 未暴露 native 健康；以 stats IPC 返回的聚合为准</span>
                <span className="badge">
                  <span className="sdot warn" />
                  unknown
                </span>
              </div>
              <div className="d-row">
                <span className="k">DB 文件 / Vacuum</span>
                <span className="v path">renderer 不暴露文件元数据（诚实标注，不编）</span>
                <span className="badge">
                  <span className="sdot off" />—
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div className="col">
            <div className={`d-card danger-audit-card ${trendTotal || sessionDangers.length ? 'has-findings' : ''}`}>
              <div className="h">
                <h3>安全审计</h3>
                <span className="sub">仅观测，不拦截</span>
                <span className="hright">本会话 {sessionDangers.length} · 跨会话 {trendTotal}</span>
              </div>
              <div className="danger-summary">
                <div className="cell">
                  <div className="lbl">高危 · 跨会话</div>
                  <div className="v bad">{trendHi}</div>
                  <div className="sub">跨会话累计标记</div>
                </div>
                <div className="cell">
                  <div className="lbl">可疑 · 跨会话</div>
                  <div className="v warn">{trendWarn}</div>
                  <div className="sub">跨会话累计标记</div>
                </div>
                <div className="cell">
                  <div className="lbl">处置</div>
                  <div className="v ok">观测</div>
                  <div className="sub">全部审计放行 · 未拦截</div>
                </div>
              </div>
              {trend.length > 0 && (
                <div className="danger-tally">
                  <span className="lbl">常见模式（跨会话）</span>
                  <div className="row">
                    {trend.slice(0, 6).map((d) => (
                      <span className={`pat ${d.level === 'warn' ? 'w' : ''}`} key={`${d.level}-${d.reason}`}>
                        {d.reason} <b>×{d.n}</b> <span>· {d.level === 'danger' ? '高危' : '可疑'}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="b">
                {sessionDangers.length === 0 ? (
                  <div className="d-row">
                    <span className="v" style={{ gridColumn: '1 / -1', color: 'var(--dim2)' }}>
                      本会话无危险操作标记。
                    </span>
                  </div>
                ) : (
                  sessionDangers.map(auditRow)
                )}
              </div>
            </div>

            <div className="d-card">
              <div className="h">
                <h3>文件追踪盲点</h3>
                <span className="sub">仅结构化工具精确</span>
              </div>
              <div className="b">
                <div className="d-row">
                  <span className="k">Read/Write/Edit</span>
                  <span className="v ok">exact · confidence 1.0</span>
                  <span className="badge">
                    <span className="sdot ok" />
                    tracked
                  </span>
                </div>
                <div className="d-row">
                  <span className="k">Bash cat/rm/{'>'}</span>
                  <span className="v warn">命令正则推断 · 启发式</span>
                  <span className="badge">
                    <span className="sdot warn" />
                    partial
                  </span>
                </div>
                <div className="d-row">
                  <span className="k">Glob / Grep</span>
                  <span className="v">仅标记 search · 不算 read/write</span>
                  <span className="badge">
                    <span className="sdot off" />—
                  </span>
                </div>
                <div className="d-row">
                  <span className="k">MCP 文件写入</span>
                  <span className="v bad">未追踪 · 已知盲点</span>
                  <span className="badge">
                    <span className="sdot bad" />
                    blind
                  </span>
                </div>
                <div className="d-row">
                  <span className="k">subagent 内部 I/O</span>
                  <span className="v warn">仅 forward 文本 · 不计入主线 file_op</span>
                  <span className="badge">
                    <span className="sdot warn" />
                    known
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="d-foot">
          <b>诊断包（导出功能未实现）</b> 拟包含：env / SQLite 元数据 / danger 审计 / MCP 状态。
          <br />
          不含任何 prompt 内容、文件原文、tool 输出、secret。
        </div>
      </div>
    </main>
  )
}
