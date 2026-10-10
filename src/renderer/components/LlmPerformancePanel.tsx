import { memo, useEffect, useId, useMemo, useState } from 'react'
import type { LlmPerformanceHistory, LlmPerformanceHistoryRow, LlmPerformanceSummary } from '@shared/llm-performance'
import { compareLlmPerformanceHistory, performanceHistoryKey, performanceEnvironmentLabel, networkConfigurationLabel } from '@shared/llm-performance'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import './llm-performance.css'

const format = (value: number | null | undefined, unit: string): string => value == null ? '—' : `${value.toFixed(1)} ${unit}`

function Trend({ summary }: { summary: LlmPerformanceSummary | null }) {
  const points = summary?.trend ?? []
  const values = points.flatMap(point => point.value == null ? [] : [point.value])
  const max = Math.max(1, ...values)
  const segments: string[] = []
  let current: string[] = []
  points.forEach(point => {
    if (point.value == null) {
      if (current.length) segments.push(current.join(' '))
      current = []
      return
    }
    const x = 388 - ((Date.parse(summary!.observedAt) - point.ts) / 30_000) * 376
    const y = 112 - (point.value / max) * 92
    current.push(`${current.length ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
  })
  if (current.length) segments.push(current.join(' '))
  return (
    <div className="llm-performance-chart-wrap">
      <svg className="llm-performance-chart" viewBox="0 0 400 132" role="img" aria-label="全部运行会话的 token 平均输出趋势">
        <line className="llm-performance-grid" x1="12" x2="388" y1="112" y2="112" />
        <line className="llm-performance-grid" x1="12" x2="388" y1="66" y2="66" />
        <line className="llm-performance-grid" x1="12" x2="388" y1="20" y2="20" />
        {segments.map((path, index) => <path key={index} className="llm-performance-line" d={path} />)}
      </svg>
      {values.length === 0 && <p className="llm-performance-chart-empty">暂无实时 token 证据</p>}
    </div>
  )
}

export function LlmPerformancePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId()
  const [summary, setSummary] = useState<LlmPerformanceSummary | null>(null)
  const [history, setHistory] = useState<LlmPerformanceHistory | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    const changed = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  useEffect(() => {
    if (!open || !visible) return
    let current = true
    let timer: number | undefined
    let historyRequest = 0
    const loadSummary = async (): Promise<void> => {
      try {
        const next = await window.scry.llmPerformanceSummary()
        if (current) { setSummary(next); setSummaryError(null) }
      } catch (error) {
        if (current) { setSummary(null); setSummaryError(error instanceof Error ? error.message : String(error)) }
      } finally {
        if (current) timer = window.setTimeout(() => { void loadSummary() }, 1000)
      }
    }
    const loadHistory = async (): Promise<void> => {
      const request = ++historyRequest
      setLoading(true)
      setHistoryError(null)
      try {
        const next = await window.scry.llmPerformanceHistory()
        if (current && request === historyRequest) setHistory(next)
      } catch (error) {
        if (current && request === historyRequest) {
          setHistory(null)
          setHistoryError(error instanceof Error ? error.message : String(error))
        }
      } finally { if (current && request === historyRequest) setLoading(false) }
    }
    void loadSummary()
    void loadHistory()
    const unsubscribe = window.scry.onDataUpdated?.(() => { void loadHistory() })
    return () => { current = false; window.clearTimeout(timer); unsubscribe?.() }
  }, [open, visible])

  if (!open) return null
  return (
    <ModalFrame labelledBy={titleId} className="llm-performance-modal" onClose={onClose}>
      <header className="modal-head">
        <div><span className="llm-performance-eyebrow">全局实时观测</span><h2 id={titleId}>LLM 性能</h2></div>
        <button type="button" className="modal-x" onClick={onClose} aria-label="关闭 LLM 性能"><Icon name="x" /></button>
      </header>
      <div className="llm-performance-body">
        <div className="llm-performance-source">
          <strong>全部运行会话{summary ? ` · ${summary.running} 个` : ''}</strong>
          {summary && <span>{summary.outputting} 个输出 · {summary.nonOutputting} 个非输出</span>}
        </div>
        {summaryError && <p role="alert">实时读取失败：{summaryError}</p>}
        <div className="llm-performance-metrics">
          <Metric label="平均输出速度" value={format(summary?.liveOutputRate, 'token/s')} coverage={summary ? `${summary.liveOutputMeasured} / ${summary.running} 可测` : '覆盖未知'} />
          <Metric label="平均首次输出等待" value={format(summary?.firstOutputWaitMs == null ? null : summary.firstOutputWaitMs / 1000, 's')} coverage={summary ? `${summary.firstOutputWaitMeasured} / ${summary.running} 已测得` : '覆盖未知'} />
          <Metric label="平均会话均速" value={format(summary?.sessionAverageRate, 'token/s')} coverage={summary ? `${summary.sessionAverageMeasured} / ${summary.running} 可测` : '覆盖未知'} />
        </div>
        <div className="llm-performance-chart-heading"><span>全部运行 · 可测会话等权平均</span><small>近 30 秒 · token/s</small></div>
        <Trend summary={summary} />
        <p className="llm-performance-unavailable" role="status">{summary?.networkConfiguration
          ? `本机配置快照采集于 ${new Date(summary.networkConfiguration.observedAt).toLocaleTimeString()}` : '本机配置线索未知'} · 配置线索 ≠ 实际请求路径</p>
        <PerformanceHistory history={history} historyError={historyError} loading={loading} />
        <details className="llm-performance-definition"><summary>数据口径</summary>{summary?.networkConfiguration && <p>{networkConfigurationLabel(summary.networkConfiguration)}。来源：{summary.networkConfiguration.source === 'app-environment' ? 'App 环境' : 'macOS 系统及 App 环境'}；启动和运行边界采集，不代表 Provider 的实际请求路径。</p>}<p>范围是 Scry 登记的全部当前运行会话，不受当前查看会话影响。每个会话等权，结束或停止后在下一次采样退出实时集合（最多 1 秒）。实时速度只接受 Provider 权威且与时间区间对齐的 token 证据；当前五类 Provider 均无此证据，因此显示不可用。首次输出等待包含启动和排队；尚未首输出的会话只计运行数。历史 API 推导与实时输出速度分开。自动网络线索只读取本机系统代理开关和 App 环境变量是否配置，不保存地址或凭据、不探测公网、VPN 或 SSID；缓存至少 30 秒。旧手动标签仅为历史备注。</p></details>
      </div>
    </ModalFrame>
  )
}

const PerformanceHistory = memo(function PerformanceHistory({ history, historyError, loading }: {
  history: LlmPerformanceHistory | null
  historyError: string | null
  loading: boolean
}) {
  const comparisons = useMemo(() => compareLlmPerformanceHistory(history?.rows ?? []), [history])
  const roundsByGroup = useMemo(() => {
    const groups = new Map<string, LlmPerformanceHistoryRow[]>()
    for (const row of history?.rows ?? []) {
      const key = performanceHistoryKey(row)
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
    return groups
  }, [history])
  return (
    <section className="llm-performance-history">
      <div className="llm-performance-history-head"><strong>历史同类对照</strong><span>按 Provider / Profile / 模型 / 上游 / 环境分组</span></div>
      {loading && <p role="status">正在读取历史…</p>}
      {historyError && <p role="alert">历史读取失败：{historyError}</p>}
      {!loading && !historyError && comparisons.length === 0 && <p>暂无历史测量。</p>}
      {!historyError && comparisons.length > 0 && <div className="llm-performance-history-list">{comparisons.map(row => (
        <div key={row.key}><article className="llm-performance-history-row">
          <div><strong>{row.model}</strong><span>{row.providerId}{row.agentProfileId ? ` · ${row.agentProfileId}` : ''}{row.upstreamProvider ? ` · ${row.upstreamProvider}` : ''}</span><small>{performanceEnvironmentLabel(roundsByGroup.get(row.key)![0])} · {row.runs} 轮 · {row.failedRuns} 失败或停止</small></div>
          <div><span>输出均速</span><b>{format(row.medianLiveTokensPerSecond, 'token/s')}</b><small>{row.liveTokenSamples} 轮可测</small></div>
          <div><span>首次输出</span><b>{format(row.medianWaitMs == null ? null : row.medianWaitMs / 1000, 's')}</b><small>{row.waitSamples} 轮有数据</small></div>
          <div><span>API 推导</span><b>{format(row.medianApiTokensPerSecond, 'token/s')}</b><small>{row.apiSamples} 轮可测</small></div>
        </article>
        <details className="llm-performance-rounds"><summary>查看 {row.runs} 轮</summary>
          {roundsByGroup.get(row.key)!.map(item => (
            <div key={item.runId} className="llm-performance-round">
              <time dateTime={item.ts}>{new Date(item.ts).toLocaleString()}</time>
              <span>{item.failed ? '失败或停止' : '完成'} · {item.runId}</span>
              <span>首次输出 {format(item.performance.firstOutputWaitMs == null ? null : item.performance.firstOutputWaitMs / 1000, 's')} · API {format(item.performance.apiTokensPerSecond, 'token/s')}</span>
              <small>输出 {item.performance.outputTokens ?? '未知'} token · API 时间 {format(item.performance.apiDurationMs == null ? null : item.performance.apiDurationMs / 1000, 's')}</small>
            </div>
          ))}
        </details></div>
      ))}</div>}
      {history && (history.invalidLines > 0 || history.truncated) && <p className="llm-performance-history-note" role="status">历史为部分证据：{history.truncated ? '已限制为最近 1000 轮；' : ''}{history.invalidLines > 0 ? `${history.invalidLines} 行损坏或不支持。` : ''}</p>}
    </section>
  )
})

function Metric({ label, value, coverage }: { label: string; value: string; coverage: string }) {
  return <dl className="llm-performance-metric"><dt>{label}</dt><dd>{value}</dd><small>{coverage}</small></dl>
}
