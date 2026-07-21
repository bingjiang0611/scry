// Analytics 全屏（蓝本 analytics.html）：跨会话聚合仪表盘。数据全来自本地 SQLite statsQuery（DbStats）。
// 诚实红线：statsQuery 返回的是**聚合**（totals/topTools/byCwd/byModel/toolStats/dangerTrend），
// **没有 per-day 时间序列、百分位、per-tool token、cache 命中率、环比**——所以蓝本的「Token 30天线 /
// danger 90天热力图 / +18.4% 环比 / P50/P95 / per-tool token share」这些**不编**，用 proposal banner 诚实标注需后端 rollup。
import { useMemo } from 'react'
import type { DbStats } from '@shared/trace'
import type { ProjectMeta } from '../env'
import { basename } from '../format'
import { Icon } from './primitives/Icon'

function fmtTokM(n: number | null): string {
  if (n == null) return '未提供'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
function modelColor(m: string): string {
  if (m.includes('sonnet')) return 'var(--accent)'
  if (m.includes('haiku')) return 'var(--ok)'
  if (m.includes('opus')) return 'var(--user)'
  return 'var(--edit)'
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function AnalyticsView({
  stats,
  projects
}: {
  stats: DbStats | null
  projects: ProjectMeta[]
}) {
  const empty =
    !stats ||
    (stats.topTools.length === 0 && stats.byModel.length === 0 && stats.byCwd.length === 0 && stats.totals.turns === 0)

  const derived = useMemo(() => {
    if (!stats) return null
    const tokens = stats.totals.tin == null && stats.totals.tout == null ? null : (stats.totals.tin ?? 0) + (stats.totals.tout ?? 0)
    const toolCalls = stats.toolStats.reduce((s, t) => s + t.n, 0) || stats.topTools.reduce((s, t) => s + t.n, 0)
    const dangerN = stats.dangerTrend.reduce((s, d) => s + d.n, 0)
    // model donut：按 token 占比生成 conic-gradient
    const models = [...stats.byModel].sort((a, b) => (b.tin ?? 0) + (b.tout ?? 0) - ((a.tin ?? 0) + (a.tout ?? 0)))
    const modelTokenSum = models.reduce((s, m) => s + (m.tin ?? 0) + (m.tout ?? 0), 0) || 1
    let acc = 0
    const stops = models
      .map((m) => {
        const from = (acc / modelTokenSum) * 100
        acc += (m.tin ?? 0) + (m.tout ?? 0)
        const to = (acc / modelTokenSum) * 100
        return `${modelColor(m.model)} ${from}% ${to}%`
      })
      .join(', ')
    const conic = models.length ? `conic-gradient(${stops})` : 'var(--border3)'
    // top tools（含 mcp）按调用数
    const tools = [...stats.toolStats].sort((a, b) => b.n - a.n)
    const maxToolN = Math.max(1, ...tools.map((t) => t.n))
    // mcp 按 server 汇总
    const mcpMap = new Map<string, { calls: number; ms: number; errors: number }>()
    for (const t of stats.toolStats) {
      if (!t.tool.startsWith('mcp')) continue
      const server = t.tool.split('__')[1] ?? t.tool
      const cur = mcpMap.get(server) ?? { calls: 0, ms: 0, errors: 0 }
      cur.calls += t.n
      cur.ms += t.avgMs * t.n
      cur.errors += t.errors
      mcpMap.set(server, cur)
    }
    const mcp = [...mcpMap.entries()].map(([server, v]) => ({ server, calls: v.calls, avgMs: v.ms / Math.max(1, v.calls), errors: v.errors })).sort((a, b) => b.calls - a.calls)
    // project 维度当前只有 turns，没有 token 明细；不伪造 token。
    const maxCwdTurns = Math.max(1, ...stats.byCwd.map((c) => c.turns))
    const proj = [...stats.byCwd]
      .sort((a, b) => b.turns - a.turns)
      .map((c) => ({
        cwd: c.cwd,
        name: basename(c.cwd),
        turns: c.turns,
        sessions: projects.find((p) => p.cwd === c.cwd)?.sessions.length ?? null
      }))
    const dmax = Math.max(1, ...stats.dangerTrend.map((d) => d.n))
    return { tokens, toolCalls, dangerN, models, conic, tools, maxToolN, mcp, proj, maxCwdTurns, dmax }
  }, [stats, projects])

  return (
    <main className="a-pane">
      <div className="proposal-banner">
        <Icon name="alert" />
        <div>
          <b>部分实现</b> · 跨会话**聚合**来自本地 SQLite statsQuery（真实）。
          <span>
            {' '}
            按天时间序列（Token 30天线 / danger 90天热力）· 环比 % · cache 命中率 · per-tool token share · MCP
            P50/P95 —— statsQuery 只返回聚合、无 per-day/百分位数据，需后端 rollup，**未建不编**。
          </span>
        </div>
      </div>

      <div className="a-hero">
        <h2>Analytics · 跨会话分析</h2>
        <div className="sub">所有数字来自本地 SQLite · 不上传 · 全时段聚合（暂无范围过滤）</div>
      </div>

      {empty || !derived ? (
        <div className="a-gap">还没有跨会话数据——发几个任务、跑几个会话后再看这里。</div>
      ) : (
        <>
          <div className="kpi-strip">
            <div className="kpi">
              <div className="lbl">total token</div>
              <div className="val accent">{fmtTokM(derived.tokens)}</div>
              <div className="sub">全部会话累计</div>
            </div>
            <div className="kpi">
              <div className="lbl">turns</div>
              <div className="val">{stats!.totals.turns}</div>
              <div className="sub">SDK result 落库</div>
            </div>
            <div className="kpi">
              <div className="lbl">tokens · all</div>
              <div className="val">{fmtTokM(stats!.totals.tin)}→{fmtTokM(stats!.totals.tout)}</div>
              <div className="sub">in {fmtTokM(stats!.totals.tin)} · out {fmtTokM(stats!.totals.tout)}</div>
            </div>
            <div className="kpi">
              <div className="lbl">tools</div>
              <div className="val">{derived.toolCalls.toLocaleString()}</div>
              <div className="sub">
                avg {stats!.totals.turns ? (derived.toolCalls / stats!.totals.turns).toFixed(2) : '0'} / turn
              </div>
            </div>
            <div className="kpi">
              <div className="lbl">danger 触发</div>
              <div className="val bad">{derived.dangerN}</div>
              <div className="sub">观测·未拦截</div>
            </div>
          </div>

          <div className="a-grid">
            {/* LEFT */}
            <div className="col">
              <div className="d-card">
                <div className="h">
                  <h3>Top Tools</h3>
                  <span className="sub">{derived.toolCalls.toLocaleString()} 次调用 · 全时段</span>
                </div>
                <div className="a-tool-head">
                  <span>tool</span>
                  <span className="num" style={{ textAlign: 'right' }}>calls</span>
                  <span className="num" style={{ textAlign: 'right' }}>avg dur</span>
                  <span className="num" style={{ textAlign: 'right' }}>fail%</span>
                  <span>dist</span>
                </div>
                {derived.tools.slice(0, 10).map((t) => {
                  const isMcp = t.tool.startsWith('mcp')
                  const failPct = t.n ? (t.errors / t.n) * 100 : 0
                  return (
                    <div className="a-tool-row" key={t.tool}>
                      <span className={`nm ${isMcp ? 'mcp' : ''}`} title={t.tool}>
                        {isMcp ? `mcp:${t.tool.split('__')[1]}` : t.tool}
                      </span>
                      <span className="num">{t.n}</span>
                      <span className="num">{fmtMs(t.avgMs)}</span>
                      <span className={`num ${failPct >= 5 ? 'warn' : ''}`}>{failPct.toFixed(1)}%</span>
                      <span className="dist">
                        <i style={{ width: `${Math.round((t.n / derived.maxToolN) * 100)}%` }} />
                      </span>
                    </div>
                  )
                })}
              </div>

              {derived.mcp.length > 0 && (
                <div className="d-card">
                  <div className="h">
                    <h3>MCP · 延迟 + 失败率</h3>
                    <span className="sub">avg（无 P50/P95：需 per-call rollup）</span>
                  </div>
                  <div className="a-tool-head" style={{ gridTemplateColumns: '1fr 54px 66px 52px 1fr' }}>
                    <span>server</span>
                    <span className="num" style={{ textAlign: 'right' }}>calls</span>
                    <span className="num" style={{ textAlign: 'right' }}>avg</span>
                    <span className="num" style={{ textAlign: 'right' }}>fail%</span>
                    <span />
                  </div>
                  {derived.mcp.map((m) => {
                    const failPct = m.calls ? (m.errors / m.calls) * 100 : 0
                    return (
                      <div className="a-tool-row" key={m.server}>
                        <span className="nm mcp">{m.server}</span>
                        <span className="num">{m.calls}</span>
                        <span className="num">{fmtMs(m.avgMs)}</span>
                        <span className={`num ${failPct >= 5 ? 'warn' : ''}`}>{failPct.toFixed(1)}%</span>
                        <span />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* RIGHT */}
            <div className="col">
              {derived.models.length > 0 && (
                <div className="d-card">
                  <div className="h">
                    <h3>Model · token 分布</h3>
                    <span className="sub">按输入+输出 token 占比</span>
                  </div>
                  <div className="a-donutwrap">
                    <div className="a-donut" style={{ background: derived.conic }}>
                      <div className="center">
                        <div className="t">{fmtTokM(derived.tokens)}</div>
                        <div className="u">TOKENS</div>
                      </div>
                    </div>
                    <div className="a-legend">
                      {derived.models.map((m) => (
                        <div className="item" key={m.model}>
                          <span className="sw" style={{ background: modelColor(m.model) }} />
                          {m.model}
                          <b>{fmtTokM(m.tin == null && m.tout == null ? null : (m.tin ?? 0) + (m.tout ?? 0))}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {derived.proj.length > 0 && (
                <div className="d-card">
                  <div className="h">
                    <h3>Project · turns</h3>
                    <span className="sub">按工作目录聚合；项目级 token 未落库</span>
                  </div>
                  <div className="a-tool-head" style={{ gridTemplateColumns: '1fr 60px 70px 1fr' }}>
                    <span>project</span>
                    <span className="num" style={{ textAlign: 'right' }}>{derived.proj.some((p) => p.sessions != null) ? 'sessions' : 'turns'}</span>
                    <span className="num" style={{ textAlign: 'right' }}>turns</span>
                    <span />
                  </div>
                  {derived.proj.map((p) => (
                    <div className="a-proj-row" key={p.cwd}>
                      <span className="nm">{p.name}</span>
                      <span className="num">{p.sessions != null ? p.sessions : p.turns}</span>
                      <span className="num cost">{p.turns}</span>
                      <span className="bar">
                        <i style={{ width: `${Math.round((p.turns / derived.maxCwdTurns) * 100)}%` }} />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {stats!.dangerTrend.length > 0 && (
                <div className="d-card">
                  <div className="h">
                    <h3>Danger · 跨会话趋势</h3>
                    <span className="sub">观测标记聚合（非日历热力：需 per-day）</span>
                  </div>
                  {stats!.dangerTrend.slice(0, 8).map((d) => (
                    <div className="a-dbar" key={`${d.level}-${d.reason}`}>
                      <span className="nm" title={d.reason}>
                        {d.reason}
                      </span>
                      <span className="n">{d.n}</span>
                      <span className="bar">
                        <i
                          className={d.level === 'danger' ? 'danger' : 'warn'}
                          style={{ width: `${Math.round((d.n / derived.dmax) * 100)}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  )
}
