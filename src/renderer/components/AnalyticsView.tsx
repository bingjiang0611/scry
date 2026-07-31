import { useMemo } from 'react'
import type { DbStats } from '@shared/trace'
import type { ProjectMeta } from '../env'
import { basename } from '../format'
import { Icon } from './primitives/Icon'

function fmtTok(n: number | null): string {
  if (n == null) return 'unknown'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
function fmtMs(ms: number | null): string {
  if (ms == null) return 'unknown'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
function fmtPct(value: number | null): string {
  if (value == null) return '无基线'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}
function modelColor(model: string): string {
  if (model.includes('sonnet')) return 'var(--accent)'
  if (model.includes('haiku')) return 'var(--ok)'
  if (model.includes('opus')) return 'var(--user)'
  return 'var(--edit)'
}

const providerLabel = { claude: 'Claude', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode' } as const

export function AnalyticsView({ stats, projects }: { stats: DbStats | null; projects: ProjectMeta[] }) {
  const tokenDaily = stats?.tokenDaily ?? []
  const dangerDaily = stats?.dangerDaily ?? []
  const cacheReuse = stats?.cacheReuse ?? []
  const mcpLatency = stats?.mcpLatency ?? []
  const providerCoverage = stats?.providerCoverage ?? []
  const comparison = stats?.comparison
  const status = stats?.status ?? (stats ? 'ready' : 'unavailable')
  const empty = !stats || (stats.topTools.length === 0 && stats.byModel.length === 0 && stats.byCwd.length === 0 && stats.totals.turns === 0)

  const derived = useMemo(() => {
    if (!stats) return null
    const tokens = stats.totals.tin == null && stats.totals.tout == null ? null : (stats.totals.tin ?? 0) + (stats.totals.tout ?? 0)
    const toolCalls = stats.totals.toolCalls ?? (stats.toolStats.reduce((sum, tool) => sum + tool.n, 0) || stats.topTools.reduce((sum, tool) => sum + tool.n, 0))
    const dangerN = stats.totals.dangerEvents ?? stats.dangerTrend.reduce((sum, item) => sum + item.n, 0)
    const models = [...stats.byModel].sort((a, b) => (b.tin ?? 0) + (b.tout ?? 0) - ((a.tin ?? 0) + (a.tout ?? 0)))
    const modelTokenSum = models.reduce((sum, model) => sum + (model.tin ?? 0) + (model.tout ?? 0), 0) || 1
    let acc = 0
    const stops = models.map((model) => {
      const from = (acc / modelTokenSum) * 100
      acc += (model.tin ?? 0) + (model.tout ?? 0)
      return `${modelColor(model.model)} ${from}% ${(acc / modelTokenSum) * 100}%`
    }).join(', ')
    const tools = [...stats.toolStats].sort((a, b) => b.n - a.n)
    const maxToolN = Math.max(1, ...tools.map((tool) => tool.n))
    const maxCwdTurns = Math.max(1, ...stats.byCwd.map((cwd) => cwd.turns))
    const proj = [...stats.byCwd].sort((a, b) => b.turns - a.turns).map((cwd) => ({
      cwd: cwd.cwd,
      name: basename(cwd.cwd),
      turns: cwd.turns,
      sessions: projects.find((project) => project.cwd === cwd.cwd)?.sessions.length ?? null
    }))
    const dmax = Math.max(1, ...stats.dangerTrend.map((item) => item.n))
    const dailyTotals = tokenDaily.map((day) => day.turns === 0 ? 0 : day.input != null && day.output != null ? day.input + day.output : null)
    const maxDaily = Math.max(1, ...dailyTotals.map((value) => value ?? 0))
    const maxDanger = Math.max(1, ...dangerDaily.map((day) => day.danger + day.warn))
    return {
      tokens,
      toolCalls,
      dangerN,
      models,
      conic: models.length ? `conic-gradient(${stops})` : 'var(--border3)',
      tools,
      maxToolN,
      proj,
      maxCwdTurns,
      dmax,
      dailyTotals,
      maxDaily,
      maxDanger
    }
  }, [stats, projects, tokenDaily, dangerDaily])

  if (status === 'unavailable' || status === 'query_error') {
    return (
      <main className="a-pane">
        <div className="a-status"><Icon name="alert" /><div><b>统计暂不可用</b><span>{status === 'query_error' ? 'SQLite 查询失败；详细原因已写入本地日志。' : 'SQLite 尚未初始化，Scry 其他功能不受影响。'}</span></div></div>
      </main>
    )
  }

  return (
    <main className="a-pane">
      <div className="a-hero">
        <h2>跨会话分析</h2>
        <div className="sub">本地 SQLite · 统计窗口 30 / 60 / 90 天 · 未知值不按 0 计</div>
      </div>

      {empty || !derived ? <div className="a-gap">还没有跨会话数据——完成几个 Provider 会话后再看这里。</div> : <>
        <div className="kpi-strip">
          <div className="kpi"><div className="lbl">累计 Token</div><div className="val accent">{fmtTok(derived.tokens)}</div><div className="sub">Provider 上报 · 全时段已知值</div></div>
          <div className="kpi"><div className="lbl">会话轮次</div><div className="val">{stats.totals.turns}</div><div className="sub">近 30 天 {comparison?.current.turns ?? 0} · {fmtPct(comparison?.change.turnsPct ?? null)}</div></div>
          <div className="kpi"><div className="lbl">近 30 天 Token</div><div className="val">{fmtTok(comparison?.current.tokens ?? null)}</div><div className="sub"><span className="a-delta">{fmtPct(comparison?.change.tokensPct ?? null)}</span> · {comparison?.current.tokenKnownTurns ?? 0}/{comparison?.current.turns ?? 0} 完整</div></div>
          <div className="kpi"><div className="lbl">工具调用</div><div className="val">{derived.toolCalls.toLocaleString()}</div><div className="sub">近 30 天 {comparison?.current.toolCalls ?? 0} · {fmtPct(comparison?.change.toolCallsPct ?? null)}</div></div>
          <div className="kpi"><div className="lbl">危险操作</div><div className="val bad">{derived.dangerN}</div><div className="sub">近 30 天 {comparison?.current.danger ?? 0} · {fmtPct(comparison?.change.dangerPct ?? null)}</div></div>
        </div>

        <div className="a-wide-grid">
          <section className="d-card a-time-card">
            <div className="h"><h3>Token 趋势 · 近 30 天</h3><span className="sub">输入 + 输出 · Provider 上报</span></div>
            <div className="a-token-chart" aria-label="最近 30 天 Token 趋势">
              {tokenDaily.map((day, index) => {
                const total = derived.dailyTotals[index]
                const missing = total == null
                return <div className="a-token-day" key={day.day} title={`${day.day} · token ${fmtTok(total)} · input ${fmtTok(day.input)} (${day.inputKnownTurns}/${day.turns}) · output ${fmtTok(day.output)} (${day.outputKnownTurns}/${day.turns})`}>
                  <i className={missing ? 'missing' : ''} style={{ height: missing ? '100%' : `${Math.max(total === 0 ? 2 : 5, ((total ?? 0) / derived.maxDaily) * 100)}%` }} />
                  {(index === 0 || index === 14 || index === 29) && <span>{day.day.slice(5)}</span>}
                </div>
              })}
            </div>
            <div className="a-chart-note">缺字段显示斜纹，不用 0 补齐；无会话的日期为真实 0。</div>
          </section>

          <section className="d-card a-time-card">
            <div className="h"><h3>危险操作 · 近 90 天</h3><span className="sub">Claude / Qoder 可分类 · Codex / OpenCode 未支持</span></div>
            <div className="a-heatmap" aria-label="最近 90 天危险操作热力图">
              {dangerDaily.map((day) => {
                const total = day.danger + day.warn
                return <i key={day.day} className={day.danger ? 'danger' : day.warn ? 'warn' : ''} style={{ opacity: total ? 0.35 + (total / derived.maxDanger) * 0.65 : 1 }} title={`${day.day} · danger ${day.danger} · warn ${day.warn}`} />
              })}
            </div>
            <div className="a-chart-note">热力格只表示已分类事件；unsupported Provider 不解释为“0 危险”。</div>
          </section>
        </div>

        <div className="a-grid">
          <div className="col">
            <section className="d-card">
              <div className="h"><h3>常用工具</h3><span className="sub">调用分布，不代表 Token 份额</span></div>
              <div className="a-tool-head"><span>tool</span><span className="num">calls</span><span className="num">avg dur</span><span className="num">fail%</span><span>dist</span></div>
              {derived.tools.slice(0, 10).map((tool) => {
                const isMcp = tool.tool.startsWith('mcp')
                const failPct = tool.n ? (tool.errors / tool.n) * 100 : 0
                return <div className="a-tool-row" key={tool.tool}>
                  <span className={`nm ${isMcp ? 'mcp' : ''}`} title={tool.tool}>{isMcp ? `mcp:${tool.tool.split('__')[1]}` : tool.tool}</span>
                  <span className="num">{tool.n}</span><span className="num">{fmtMs(tool.avgMs)}</span><span className={`num ${failPct >= 5 ? 'warn' : ''}`}>{failPct.toFixed(1)}%</span>
                  <span className="dist"><i style={{ width: `${Math.round((tool.n / derived.maxToolN) * 100)}%` }} /></span>
                </div>
              })}
              <div className="a-chart-note">四个 Provider 均未提供 tool-level Token 归因，因此不估算 per-tool Token share。</div>
            </section>

            {mcpLatency.length > 0 && <section className="d-card">
              <div className="h"><h3>MCP 延迟 · 近 90 天</h3><span className="sub">仅统计已完成调用 · nearest-rank</span></div>
              <div className="a-mcp-head"><span>server</span><span>calls</span><span>P50</span><span>P95</span><span>fail%</span></div>
              {mcpLatency.map((server) => <div className="a-mcp-row" key={server.server}><span className="nm">{server.server}</span><span>{server.calls}</span><span>{fmtMs(server.p50Ms)}</span><span>{fmtMs(server.p95Ms)}</span><span className={server.errors ? 'warn' : ''}>{server.calls ? ((server.errors / server.calls) * 100).toFixed(1) : '0.0'}%</span></div>)}
            </section>}

            <section className="d-card">
              <div className="h"><h3>缓存 Token · 近 30 天</h3><span className="sub">按 Provider 语义计算</span></div>
              {cacheReuse.map((row) => {
                const formula = row.denominator === 'separate_input' ? 'read / (input + read + write)' : row.denominator === 'input_includes_cache' ? 'cached input / input' : '上游分母不可证明'
                return <div className="a-cache-row" key={row.providerId}>
                  <b>{providerLabel[row.providerId]}</b><strong>{row.reuseRate == null ? 'unknown' : `${(row.reuseRate * 100).toFixed(1)}%`}</strong>
                  <span>read {fmtTok(row.cacheReadTokens)} · write {fmtTok(row.cacheWriteTokens)} · comparable {row.comparableTurns}/{row.turns}</span><em>{formula}</em>
                </div>
              })}
            </section>
          </div>

          <div className="col">
            {derived.models.length > 0 && <section className="d-card">
              <div className="h"><h3>模型 Token 分布</h3><span className="sub">输入 + 输出</span></div>
              <div className="a-donutwrap"><div className="a-donut" style={{ background: derived.conic }}><div className="center"><div className="t">{fmtTok(derived.tokens)}</div><div className="u">Token</div></div></div><div className="a-legend">{derived.models.map((model) => <div className="item" key={model.model}><span className="sw" style={{ background: modelColor(model.model) }} />{model.model}<b>{fmtTok(model.tin == null && model.tout == null ? null : (model.tin ?? 0) + (model.tout ?? 0))}</b></div>)}</div></div>
            </section>}

            <section className="d-card">
              <div className="h"><h3>Provider 覆盖 · 近 30 天</h3><span className="sub">已知值 / 轮次 · 已映射 {providerCoverage.reduce((sum, row) => sum + row.turns, 0)}/{comparison?.current.turns ?? 0}</span></div>
              <div className="a-coverage-head"><span>Provider</span><span>in</span><span>out</span><span>cache R</span><span>cache W</span><span>danger</span></div>
              {providerCoverage.map((row) => <div className="a-coverage-row" key={row.providerId}><b>{providerLabel[row.providerId]}</b><span>{row.inputKnownTurns}/{row.turns}</span><span>{row.outputKnownTurns}/{row.turns}</span><span>{row.cacheReadKnownTurns}/{row.turns}</span><span>{row.cacheWriteKnownTurns}/{row.turns}</span><em className={row.dangerCoverage}>{row.dangerCoverage}</em></div>)}
            </section>

            {derived.proj.length > 0 && <section className="d-card">
              <div className="h"><h3>项目会话轮次</h3><span className="sub">按工作目录聚合</span></div>
              {derived.proj.map((project) => <div className="a-proj-row" key={project.cwd}><span className="nm">{project.name}</span><span className="num">{project.sessions ?? project.turns}</span><span className="num cost">{project.turns}</span><span className="bar"><i style={{ width: `${Math.round((project.turns / derived.maxCwdTurns) * 100)}%` }} /></span></div>)}
            </section>}

            {stats.dangerTrend.length > 0 && <section className="d-card">
              <div className="h"><h3>危险原因分布</h3><span className="sub">全时段已分类事件</span></div>
              {stats.dangerTrend.slice(0, 8).map((item) => <div className="a-dbar" key={`${item.level}-${item.reason}`}><span className="nm" title={item.reason}>{item.reason}</span><span className="n">{item.n}</span><span className="bar"><i className={item.level === 'danger' ? 'danger' : 'warn'} style={{ width: `${Math.round((item.n / derived.dmax) * 100)}%` }} /></span></div>)}
            </section>}
          </div>
        </div>
      </>}
    </main>
  )
}
