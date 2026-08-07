import { useMemo, useState } from 'react'
import type { ProviderId } from '@shared/provider'
import type { DbStats } from '@shared/trace'
import type { ProjectMeta } from '../env'
import { Icon } from './primitives/Icon'

type EvidenceState = 'exact' | 'lower' | 'unknown' | 'unsupported' | 'zero' | 'warn' | 'danger'
type ChapterId = 'field' | 'coverage' | 'operations' | 'risk'

const providers: { id: ProviderId; label: string; short: string }[] = [
  { id: 'claude', label: 'Claude Code', short: 'CLAUDE' },
  { id: 'codex', label: 'Codex', short: 'CODEX' },
  { id: 'qoder', label: 'Qoder', short: 'QODER' },
  { id: 'opencode', label: 'OpenCode', short: 'OPENCODE' }
]

const chapters: { id: ChapterId; index: string; label: string }[] = [
  { id: 'field', index: '00', label: '近 30 天' },
  { id: 'coverage', index: '01', label: 'Provider 覆盖' },
  { id: 'operations', index: '02', label: '工具与延迟' },
  { id: 'risk', index: '03', label: '风险与盲区' }
]

const stateLabel: Record<EvidenceState, string> = {
  exact: '精确值',
  lower: '已知下界',
  unknown: '未知',
  unsupported: '未支持',
  zero: '真实 0',
  warn: 'Warn',
  danger: 'Danger'
}

function fmtTok(value: number | null): string {
  if (value == null) return '—'
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function fmtMs(value: number | null): string {
  if (value == null) return '—'
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`
}

function fmtRate(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

function coverageState(known: number, turns: number): EvidenceState {
  if (turns === 0) return 'zero'
  if (known === 0) return 'unknown'
  return known < turns ? 'lower' : 'exact'
}

function EvidenceValue({ value, state, suffix }: { value: string; state: EvidenceState; suffix?: string }) {
  return (
    <span className={`ae-value is-${state}`} data-state={state} title={stateLabel[state]}>
      <b>{state === 'unknown' || state === 'unsupported' ? '—' : value}</b>
      {suffix && <small>{suffix}</small>}
    </span>
  )
}

function EvidenceStatus({ state, label }: { state: EvidenceState; label?: string }) {
  return <span className={`ae-status is-${state}`}><i />{label ?? stateLabel[state]}</span>
}

function EvidenceRow({ label, value, state = 'exact', note }: { label: string; value: string; state?: EvidenceState; note?: string }) {
  return (
    <div className="ae-evidence-row">
      <span>{label}</span><i />
      <EvidenceValue value={value} state={state} />
      {note && <small>{note}</small>}
    </div>
  )
}

function ProviderDot({ id }: { id: ProviderId }) {
  return <i className={`ae-provider-dot is-${id}`} />
}

export function AnalyticsView({ stats, projects }: { stats: DbStats | null; projects: ProjectMeta[] }) {
  const status = stats?.status ?? (stats ? 'ready' : 'unavailable')
  const [chapter, setChapter] = useState<ChapterId>('field')
  const [selectedDay, setSelectedDay] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null)

  const evidence = useMemo(() => {
    if (!stats) return null
    const tokenDaily = stats.tokenDaily
    const days = (tokenDaily ?? []).map((day) => {
      const knownFields = day.inputKnownTurns + day.outputKnownTurns
      const observed = knownFields > 0 ? (day.input ?? 0) + (day.output ?? 0) : null
      const complete = day.turns > 0 && day.inputKnownTurns === day.turns && day.outputKnownTurns === day.turns
      const state: EvidenceState = day.turns === 0
        ? 'zero'
        : knownFields === 0
          ? 'unknown'
          : complete
            ? observed === 0 ? 'zero' : 'exact'
            : 'lower'
      return { ...day, observed, state }
    })
    const current = stats.comparison?.current
    const observedWindow = days.some((day) => day.observed != null)
      ? days.reduce((sum, day) => sum + (day.observed ?? 0), 0)
      : current?.tokens ?? null
    const recentState: EvidenceState = !current
      ? 'unknown'
      : current.turns === 0
        ? 'zero'
        : current.tokenKnownTurns === 0 && observedWindow == null
          ? 'unknown'
          : current.tokenKnownTurns < current.turns
            ? 'lower'
            : observedWindow === 0 ? 'zero' : 'exact'
    const maxDay = Math.max(1, ...days.map((day) => day.observed ?? 0))
    const activeDays = days.filter((day) => day.turns > 0)
    const peakKnown = [...days].sort((a, b) => (b.observed ?? 0) - (a.observed ?? 0)).slice(0, 3).reduce((sum, day) => sum + (day.observed ?? 0), 0)
    const peakShare = observedWindow && observedWindow > 0 ? Math.round((peakKnown / observedWindow) * 100) : null

    const tools = stats.toolStats.length > 0
      ? [...stats.toolStats].sort((a, b) => b.n - a.n).map((tool) => ({ ...tool, avgMs: tool.avgMs as number | null, errors: tool.errors as number | null }))
      : stats.topTools.map((tool) => ({ tool: tool.tool, n: tool.n, avgMs: null, errors: null }))
    const maxToolCalls = Math.max(1, ...tools.map((tool) => tool.n))
    const dangerReady = stats.dangerDaily !== undefined && stats.dangerDaily.length > 0
    const dangerCount = dangerReady ? stats.dangerDaily!.reduce((sum, day) => sum + day.danger, 0) : null
    const warnCount = dangerReady ? stats.dangerDaily!.reduce((sum, day) => sum + day.warn, 0) : null
    return {
      days,
      tokenDailyReady: tokenDaily !== undefined && tokenDaily.length > 0,
      observedWindow,
      recentState,
      current,
      maxDay,
      activeDays,
      peakShare,
      tools,
      maxToolCalls,
      dangerReady,
      dangerCount,
      warnCount
    }
  }, [stats])

  if (status === 'unavailable' || status === 'query_error' || !stats || !evidence) {
    return (
      <main className="analytics-evidence">
        <div className="ae-source-error">
          <Icon name="alert" />
          <div><b>统计暂不可用</b><span>{status === 'query_error' ? 'SQLite 查询失败；详细原因已写入本地日志。' : 'SQLite 尚未初始化，Scry 其他功能不受影响。'}</span></div>
        </div>
      </main>
    )
  }

  const currentDay = evidence.days.find((day) => day.day === selectedDay) ?? evidence.days.at(-1)
  const currentInputState = currentDay ? (currentDay.turns === 0 ? 'zero' : coverageState(currentDay.inputKnownTurns, currentDay.turns)) : 'unknown'
  const currentOutputState = currentDay ? (currentDay.turns === 0 ? 'zero' : coverageState(currentDay.outputKnownTurns, currentDay.turns)) : 'unknown'
  const selectedCoverage = selectedProvider ? stats.providerCoverage?.find((row) => row.providerId === selectedProvider) : undefined
  const selectedCache = selectedProvider ? stats.cacheReuse?.find((row) => row.providerId === selectedProvider) : undefined
  const selectedMeta = selectedProvider ? providers.find((provider) => provider.id === selectedProvider) : undefined
  const riskUnsupported = selectedCoverage?.dangerCoverage === 'unsupported'
  const riskCapabilityUnknown = selectedProvider !== null && selectedCoverage === undefined

  const toggleProvider = (providerId: ProviderId) => {
    setSelectedProvider((current) => current === providerId ? null : providerId)
  }

  const recentHeadline = evidence.recentState === 'zero'
    ? '近 30 天没有会话；这是查询成功后的真实 0。'
    : evidence.recentState === 'unknown'
      ? '近 30 天存在会话，但没有可验证的 Token 字段。'
      : !evidence.tokenDailyReady
        ? '近 30 天汇总可读，但日级证据字段缺失。'
      : evidence.peakShare == null
        ? '每一天都保留来源与覆盖状态。'
        : `三个高峰日承载了 ${evidence.peakShare}% 的已知 Token。`

  return (
    <main className="analytics-evidence">
      <div className="ae-shell">
        <header className="ae-header">
          <div>
            <span>ANALYTICS · LOCAL EVIDENCE LEDGER</span>
            <h1>从量到证据，再到能力盲区</h1>
            <p>四章共享同一事实口径；高亮只改变聚焦，不改写 SQLite 汇总。</p>
          </div>
          <EvidenceStatus state="exact" label="本机 SQLite" />
        </header>

        <nav className="ae-tabs" aria-label="分析章节">
          {chapters.map((item) => (
            <button
              type="button"
              key={item.id}
              className={chapter === item.id ? 'active' : ''}
              onClick={() => setChapter(item.id)}
              aria-current={chapter === item.id ? 'page' : undefined}
            >
              <span>{item.index}</span>{item.label}
            </button>
          ))}
          <span className="ae-focus">{(chapter === 'coverage' || chapter === 'risk') && selectedMeta ? `${selectedMeta.short} HIGHLIGHT` : 'ALL PROVIDERS'}</span>
        </nav>

        <section className="ae-chapter" hidden={chapter !== 'field'} aria-label="近 30 天">
          <article className="ae-story">
            <span className="ae-code">00 · THE FIELD</span>
            <EvidenceStatus state={evidence.recentState} label={`近 30 天 · ${stateLabel[evidence.recentState]}`} />
            <EvidenceValue
              value={`${evidence.recentState === 'lower' ? '≥ ' : ''}${fmtTok(evidence.recentState === 'zero' ? 0 : evidence.observedWindow)}`}
              state={evidence.recentState}
              suffix="已知 Token"
            />
            <h2>{recentHeadline}</h2>
            <p>每一列代表一个本地日期，长度只编码 Provider 已上报的输入与输出 Token。斜纹保留已知量并标明缺字段，不用 0 补齐。</p>
            <div className="ae-metrics">
              <span><b>{evidence.activeDays.length}</b><small>活跃日</small></span>
              <span><b>{evidence.current?.turns ?? '—'}</b><small>轮次</small></span>
              <span><b>{evidence.current ? `${evidence.current.tokenKnownTurns}/${evidence.current.turns}` : '—'}</b><small>完整 Token</small></span>
              <span><b>{projects.length}</b><small>项目索引</small></span>
            </div>
            <div className="ae-source"><span>真实数据</span><i /><b>本机 SQLite · tokenDaily / comparison</b></div>
          </article>

          <div className="ae-visual ae-field-panel">
            <div className="ae-visual-meta"><span>OBSERVED TOKEN · 30 LOCAL DAYS</span><span>选择日期查看证据</span></div>
            {!evidence.tokenDailyReady ? (
              <div className="ae-unknown-panel"><EvidenceValue value="—" state="unknown" /><p>当前 preload 没有返回 tokenDaily，不能把缺失的时间序列画成 0。</p></div>
            ) : (
              <div className="ae-day-field" role="list" aria-label="近 30 天已知 Token">
                {evidence.days.map((day, index) => {
                  const active = currentDay?.day === day.day
                  return (
                    <button
                      type="button"
                      key={day.day}
                      className={`ae-day is-${day.state} ${active ? 'active' : ''}`}
                      onClick={() => setSelectedDay(day.day)}
                      aria-pressed={active}
                      aria-label={`${day.day}，${stateLabel[day.state]}，${day.state === 'lower' ? '至少 ' : ''}${fmtTok(day.state === 'zero' ? 0 : day.observed)} Token`}
                    >
                      <span><i style={{ height: `${day.observed == null ? 100 : Math.max(day.observed === 0 ? 2 : 7, (day.observed / evidence.maxDay) * 100)}%` }} /></span>
                      {(index === 0 || index === Math.floor(evidence.days.length / 2) || index === evidence.days.length - 1) && <time>{day.day.slice(5)}</time>}
                    </button>
                  )
                })}
              </div>
            )}
            {currentDay && (
              <div className="ae-day-ledger">
                <header><b>{currentDay.day}</b><EvidenceStatus state={currentDay.state} /></header>
                <EvidenceRow label="OBSERVED TOKEN" value={`${currentDay.state === 'lower' ? '≥ ' : ''}${fmtTok(currentDay.observed ?? (currentDay.turns === 0 ? 0 : null))}`} state={currentDay.state} />
                <EvidenceRow label="INPUT" value={`${currentInputState === 'lower' ? '≥ ' : ''}${fmtTok(currentDay.turns === 0 ? 0 : currentDay.input)}`} state={currentInputState} note={`${currentDay.inputKnownTurns}/${currentDay.turns} turns`} />
                <EvidenceRow label="OUTPUT" value={`${currentOutputState === 'lower' ? '≥ ' : ''}${fmtTok(currentDay.turns === 0 ? 0 : currentDay.output)}`} state={currentOutputState} note={`${currentDay.outputKnownTurns}/${currentDay.turns} turns`} />
              </div>
            )}
          </div>
        </section>

        <section className="ae-chapter" hidden={chapter !== 'coverage'} aria-label="Provider 覆盖">
          <article className="ae-story">
            <span className="ae-code">01 · COVERAGE</span>
            <EvidenceStatus state={evidence.recentState} label="近 30 天 · 证据优先" />
            <div className="ae-ratio">
              <b>{evidence.current?.tokenKnownTurns ?? '—'}</b><span>/{evidence.current?.turns ?? '—'}</span>
            </div>
            <small className="ae-unit">轮次具备完整输入 + 输出 Token</small>
            <h2>覆盖度先于排名；不完整的总量只能是下界。</h2>
            <p>Provider 色只表示来源。青色轮廓是当前选择，不复用为数据色；点击任意行查看字段覆盖、缓存口径与危险分类能力。</p>
            <div className="ae-source"><span>真实数据</span><i /><b>providerCoverage / cacheReuse · 近 30 天</b></div>
          </article>

          <div className="ae-visual ae-provider-panel">
            <div className="ae-provider-head"><span>PROVIDER</span><span>TURNS</span><span>INPUT</span><span>OUTPUT</span><span>DANGER</span></div>
            <div className="ae-provider-list">
              {providers.map((provider, index) => {
                const row = stats.providerCoverage?.find((item) => item.providerId === provider.id)
                return (
                  <button type="button" key={provider.id} className={selectedProvider === provider.id ? 'active' : ''} onClick={() => toggleProvider(provider.id)} aria-pressed={selectedProvider === provider.id}>
                    <span className="ae-provider-name"><i>{String(index + 1).padStart(2, '0')}</i><ProviderDot id={provider.id} /><b>{provider.label}</b><small>{provider.short}</small></span>
                    <EvidenceValue value={row ? String(row.turns) : '—'} state={!row ? 'unknown' : row.turns === 0 ? 'zero' : 'exact'} />
                    <EvidenceValue value={row ? `${row.inputKnownTurns}/${row.turns}` : '—'} state={!row ? 'unknown' : row.turns === 0 ? 'zero' : 'exact'} />
                    <EvidenceValue value={row ? `${row.outputKnownTurns}/${row.turns}` : '—'} state={!row ? 'unknown' : row.turns === 0 ? 'zero' : 'exact'} />
                    <EvidenceStatus state={!row ? 'unknown' : row.dangerCoverage === 'unsupported' ? 'unsupported' : 'exact'} label={!row ? '未知' : row.dangerCoverage === 'unsupported' ? '未支持' : '已分类'} />
                  </button>
                )
              })}
            </div>
            <div className={`ae-selection ${selectedMeta ? '' : 'is-empty'}`}>
              {selectedMeta ? (
                <>
                  <header><ProviderDot id={selectedMeta.id} /><b>{selectedMeta.label}</b></header>
                  <EvidenceRow label="TOKEN INPUT" value={selectedCoverage ? `${selectedCoverage.inputKnownTurns}/${selectedCoverage.turns} turns` : '—'} state={!selectedCoverage ? 'unknown' : selectedCoverage.turns === 0 ? 'zero' : 'exact'} note={selectedCoverage && selectedCoverage.inputKnownTurns < selectedCoverage.turns ? '部分轮次 input token 未知' : undefined} />
                  <EvidenceRow label="TOKEN OUTPUT" value={selectedCoverage ? `${selectedCoverage.outputKnownTurns}/${selectedCoverage.turns} turns` : '—'} state={!selectedCoverage ? 'unknown' : selectedCoverage.turns === 0 ? 'zero' : 'exact'} note={selectedCoverage && selectedCoverage.outputKnownTurns < selectedCoverage.turns ? '部分轮次 output token 未知' : undefined} />
                  <EvidenceRow
                    label="CACHE REUSE"
                    value={fmtRate(selectedCache?.reuseRate ?? null)}
                    state={!selectedCache || selectedCache.reuseRate == null ? 'unknown' : selectedCache.reuseRate === 0 ? 'zero' : 'exact'}
                    note={!selectedCache ? '统计字段未返回' : selectedCache.denominator === 'separate_input' ? 'read / (input + read + write)' : selectedCache.denominator === 'input_includes_cache' ? 'cached input / input' : '上游分母不可证明'}
                  />
                  <EvidenceRow label="DANGER" value={selectedCoverage?.dangerCoverage === 'classified' ? '已分类' : '—'} state={!selectedCoverage ? 'unknown' : selectedCoverage.dangerCoverage === 'unsupported' ? 'unsupported' : 'exact'} note={selectedCoverage?.dangerCoverage === 'unsupported' ? '未支持不等于安全' : '观测与分类，不代表拦截'} />
                </>
              ) : <p>选择一个 Provider 查看字段覆盖、缓存计算口径与能力盲区。</p>}
            </div>
          </div>
        </section>

        <section className="ae-chapter" hidden={chapter !== 'operations'} aria-label="工具与延迟">
          <article className="ae-story">
            <span className="ae-code">02 · OPERATIONS</span>
            <EvidenceStatus state={!evidence.tools[0] || evidence.tools[0].n === 0 ? 'zero' : 'exact'} label="全时段 · 调用次数排序" />
            <EvidenceValue value={String(evidence.tools[0]?.n ?? 0)} state={!evidence.tools[0] || evidence.tools[0].n === 0 ? 'zero' : 'exact'} suffix={`${evidence.tools[0]?.tool ?? 'tool'} calls`} />
            <h2>{evidence.tools.length === 0 ? '没有已记录的工具调用。' : `${evidence.tools[0].tool} 是调用最多的一类工具。`}</h2>
            <p>条长只编码调用次数；平均耗时和失败次数来自已完成的 tool span。没有 tool-level Token 归因，因此不制造 Token 份额。</p>
            <div className="ae-source"><span>真实数据</span><i /><b>toolStats 全时段 · mcpLatency 近 90 天</b></div>
          </article>

          <div className="ae-visual ae-operations-panel">
            <div className="ae-tool-head"><span>TOOL</span><span>CALLS</span><span>AVG</span><span>FAIL</span></div>
            <div className="ae-tool-list">
              {evidence.tools.length === 0 ? (
                <div className="ae-zero-panel"><EvidenceValue value="0" state="zero" /><p>SQLite 查询成功，当前没有工具调用记录。</p></div>
              ) : evidence.tools.slice(0, 10).map((tool, index) => (
                <div className="ae-tool-row" key={tool.tool}>
                  <span className="ae-tool-name"><i>{String(index + 1).padStart(2, '0')}</i><b title={tool.tool}>{tool.tool}</b><small>{tool.tool.startsWith('mcp') ? 'MCP' : 'NATIVE'}</small></span>
                  <span className="ae-tool-bar"><i style={{ width: `${(tool.n / evidence.maxToolCalls) * 100}%` }} /></span>
                  <b>{tool.n}</b>
                  <EvidenceValue value={fmtMs(tool.avgMs)} state={tool.avgMs == null ? 'unknown' : tool.avgMs === 0 ? 'zero' : 'exact'} />
                  <EvidenceValue value={tool.errors == null ? '—' : String(tool.errors)} state={tool.errors == null ? 'unknown' : tool.errors === 0 ? 'zero' : 'exact'} />
                </div>
              ))}
            </div>
            <div className="ae-latency">
              <header><span>LATENCY LEDGER</span><b>MCP · 近 90 天</b></header>
              {stats.mcpLatency === undefined ? (
                <EvidenceRow label="MCP LATENCY" value="—" state="unknown" note="当前 preload 未返回该字段" />
              ) : stats.mcpLatency.length === 0 ? (
                <EvidenceRow label="COMPLETED MCP CALLS" value="0" state="zero" note="查询成功，无已完成样本" />
              ) : stats.mcpLatency.map((server) => (
                <div className="ae-latency-row" key={server.server}>
                  <b title={server.server}>{server.server}</b>
                  <span>{server.calls} calls</span>
                  <EvidenceValue value={`P50 ${fmtMs(server.p50Ms)}`} state={server.p50Ms == null ? 'unknown' : server.p50Ms === 0 ? 'zero' : 'exact'} />
                  <EvidenceValue value={`P95 ${fmtMs(server.p95Ms)}`} state={server.p95Ms == null ? 'unknown' : server.p95Ms === 0 ? 'zero' : 'exact'} />
                  <EvidenceValue value={server.calls ? `${((server.errors / server.calls) * 100).toFixed(1)}% fail` : '—'} state={server.calls === 0 ? 'unknown' : server.errors === 0 ? 'zero' : 'exact'} />
                </div>
              ))}
              <p>百分位仅使用已完成且带 duration 的调用，算法为 nearest-rank。</p>
            </div>
          </div>
        </section>

        <section className="ae-chapter" hidden={chapter !== 'risk'} aria-label="风险与盲区">
          <article className="ae-story">
            <span className="ae-code">03 · RISK</span>
            <EvidenceStatus
              state={riskUnsupported ? 'unsupported' : riskCapabilityUnknown || !evidence.dangerReady ? 'unknown' : evidence.dangerCount === 0 && evidence.warnCount === 0 ? 'zero' : 'exact'}
              label={riskUnsupported ? `${selectedMeta?.label} · 分类未支持` : riskCapabilityUnknown ? `${selectedMeta?.label} · 能力未知` : '近 90 天 · 可分类范围'}
            />
            <EvidenceValue
              value={riskUnsupported || evidence.dangerCount == null ? '—' : String(evidence.dangerCount)}
              state={riskUnsupported ? 'unsupported' : riskCapabilityUnknown || !evidence.dangerReady ? 'unknown' : evidence.dangerCount === 0 && evidence.warnCount === 0 ? 'zero' : 'exact'}
              suffix={!riskUnsupported && evidence.warnCount != null ? `danger · ${evidence.warnCount} warn` : undefined}
            />
            <h2>{riskUnsupported ? `${selectedMeta?.label} 没有危险分类能力，不能得出“零危险”。` : riskCapabilityUnknown ? `${selectedMeta?.label} 的分类能力字段未知，不能推断安全状态。` : selectedMeta ? `${selectedMeta.label} 的能力已高亮；矩阵仍是可分类 Provider 汇总。` : '已分类事件与能力盲区必须分开阅读。'}</h2>
            <p>红色与黄色只表示可分类 Provider 的已记录事件。空格是该范围内的真实 0；unsupported 使用斜纹，不会伪装成安全。</p>
            <div className="ae-source"><span>真实数据</span><i /><b>dangerDaily 近 90 天 · providerCoverage capability</b></div>
          </article>

          <div className="ae-visual ae-risk-panel">
            <div className="ae-visual-meta"><span>90 LOCAL DAYS · CLASSIFIED EVENTS</span><span>{selectedMeta ? `${selectedMeta.short} CAPABILITY · AGGREGATE GRID` : 'ALL CLASSIFIED PROVIDERS'}</span></div>
            {riskCapabilityUnknown || !evidence.dangerReady ? (
              <div className="ae-unknown-panel"><EvidenceValue value="—" state="unknown" /><p>{riskCapabilityUnknown ? '当前 preload 没有返回所选 Provider 的分类能力，不能推断风险状态。' : '当前 preload 没有返回完整的 dangerDaily，不能把缺失矩阵画成 0。'}</p></div>
            ) : (
              <div className={`ae-risk-grid ${riskUnsupported ? 'is-unsupported' : ''}`} aria-label="近 90 天危险操作矩阵">
                {stats.dangerDaily!.map((day) => {
                  const cellState: EvidenceState = riskUnsupported ? 'unsupported' : day.danger > 0 ? 'danger' : day.warn > 0 ? 'warn' : 'zero'
                  return <i key={day.day} className={`is-${cellState} ${day.danger > 0 ? 'has-danger' : day.warn > 0 ? 'has-warn' : ''}`} title={`${day.day} · ${riskUnsupported ? '未支持分类' : `${day.danger} danger · ${day.warn} warn`}`} />
                })}
              </div>
            )}
            <div className="ae-legend"><EvidenceStatus state="danger" /><EvidenceStatus state="warn" /><EvidenceStatus state="zero" /><EvidenceStatus state="unsupported" /></div>
            <div className="ae-capabilities">
              {providers.map((provider) => {
                const row = stats.providerCoverage?.find((item) => item.providerId === provider.id)
                const capabilityState: EvidenceState = !row ? 'unknown' : row.dangerCoverage === 'unsupported' ? 'unsupported' : 'exact'
                return (
                  <button type="button" key={provider.id} className={selectedProvider === provider.id ? 'active' : ''} onClick={() => toggleProvider(provider.id)} aria-pressed={selectedProvider === provider.id}>
                    <span><ProviderDot id={provider.id} />{provider.label}</span>
                    <EvidenceValue value={row?.dangerCoverage === 'classified' ? '已分类' : '—'} state={capabilityState} />
                    <small>{!row ? '能力字段未知' : row.dangerCoverage === 'unsupported' ? '未支持 · 不等于安全' : row.turns === 0 ? '无会话样本 · 能力可用' : '分类可用 · 观测不拦截'}</small>
                  </button>
                )
              })}
            </div>
            <div className="ae-reasons">
              <header><span>ALL-TIME CLASSIFIED REASONS</span><b>SQLite dangerTrend</b></header>
              {stats.dangerTrend.length === 0 ? <EvidenceRow label="CLASSIFIED EVENTS" value="0" state="zero" /> : stats.dangerTrend.slice(0, 6).map((reason) => (
                <EvidenceRow key={`${reason.level}-${reason.reason}`} label={reason.reason} value={String(reason.n)} state={reason.n === 0 ? 'zero' : 'exact'} note={reason.level} />
              ))}
            </div>
          </div>
        </section>

        <footer className="ae-footer">
          <div className="ae-source"><span>本机证据</span><i /><b>{stats.totals.turns.toLocaleString()} 轮全时段记录 · {projects.length} 个项目索引</b></div>
          <span>UNKNOWN ≠ 0 · UNSUPPORTED ≠ SAFE</span>
        </footer>
      </div>
    </main>
  )
}
