import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { LlmPerformanceHistory } from '@shared/llm-performance'
import { compareLlmPerformance, liveCharactersPerSecond } from '@shared/llm-performance'
import type { Turn } from '../format'
import { Icon } from './primitives/Icon'
import './llm-performance.css'

interface Props {
  turns: Turn[]
  busy: boolean
  networkLabel: string
  onNetworkLabel: (label: string) => void
}

const number = (value: number | undefined, unit: string): string => value == null ? '—' : `${value.toFixed(1)} ${unit}`

export function LlmPerformancePanel({ turns, busy, networkLabel, onNetworkLabel }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [history, setHistory] = useState<LlmPerformanceHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [networkFilter, setNetworkFilter] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const detailsId = useId()
  const latestTurn = turns.at(-1)
  const sample = latestTurn?.items.findLast(event => event.llmPerformance)?.llmPerformance
  const revision = sample?.state === 'complete' ? sample.observedAt : ''

  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [busy])

  const loadHistory = useCallback(async (isCurrent: () => boolean = () => true) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.scry.llmPerformanceHistory()
      if (isCurrent()) setHistory(result)
    } catch (failure) {
      if (isCurrent()) setError(String(failure instanceof Error ? failure.message : failure))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!expanded) return
    let current = true
    void loadHistory(() => current)
    return () => { current = false }
  }, [expanded, revision, loadHistory])

  const comparisons = useMemo(() => compareLlmPerformance((history?.rows ?? []).filter(row =>
    (!networkFilter || row.networkLabel === networkFilter) && (!providerFilter || row.providerId === providerFilter))),
  [history, networkFilter, providerFilter])
  const networks = useMemo(() => [...new Set(history?.rows.map(row => row.networkLabel).filter(Boolean))], [history])
  const rate = sample && busy ? liveCharactersPerSecond(sample, now) : undefined
  const status = !sample ? (busy ? '等待测速证据' : '尚无测量') : !busy || sample.state === 'complete' ? '本轮统计'
    : sample.state === 'tool' ? '工具执行中' : sample.state === 'buffered' ? '整段输出 · 非流式'
      : sample.state === 'streaming' ? '接收中' : '等待模型输出'

  return (
    <section className="llm-performance" aria-label="LLM 性能">
      <button type="button" className="llm-performance-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
        <span className="llm-performance-heading">LLM 性能</span>
        <span className="llm-performance-status">{status}</span>
        <span className="llm-performance-readout">{busy ? '实时' : '接收均速'} <b>{number(busy ? rate : sample?.averageCharactersPerSecond, '字符/s')}</b></span>
        <span className="llm-performance-readout">首次输出 <b>{number(sample?.firstOutputWaitMs == null ? undefined : sample.firstOutputWaitMs / 1000, 's')}</b></span>
        <span className="llm-performance-action">对比 <Icon name={expanded ? 'chevronUp' : 'chevronDown'} /></span>
      </button>
      {expanded && <div id={detailsId} className="llm-performance-details">
        <div className="llm-performance-controls">
          <label>下次运行的网络标签 <input aria-label="下次运行的网络标签" maxLength={80} placeholder="如：直连 / VPN A" value={networkLabel} onChange={event => onNetworkLabel(event.target.value)} /></label>
          <button type="button" className="btn" disabled={loading} onClick={() => { void loadHistory() }}>刷新历史</button>
        </div>
        <div className="llm-performance-current">
          <span>本轮标签 <b>{sample?.networkLabel || '未标注'}</b></span>
          <span>流式接收 <b>{sample?.streamCharacters.toLocaleString() ?? '—'} 字符</b></span>
          <span title="Provider 报告的本轮输出 tokens ÷ API 累计耗时，包含 prefill/推理，可含子代理；不是实时解码速度">本轮 API 吞吐 <b>{number(sample?.apiTokensPerSecond, 'tok/s')}</b></span>
        </div>
        <p className="llm-performance-note">实时速度为主会话最近 3 秒的文本接收量，不将消息块当作 token。首次输出等待包含启动、排队和本地开销，不是请求 TTFT。接收均速按可计时片段计算，工具等待不计入；缺失计时显示 —。</p>
        <div className="llm-performance-filters">
          <strong>网络 / 模型对比</strong>
          <select aria-label="按网络筛选" value={networkFilter} onChange={event => setNetworkFilter(event.target.value)}>
            <option value="">全部网络</option>{networks.map(network => <option key={network} value={network}>{network}</option>)}
          </select>
          <select aria-label="按 Provider 筛选" value={providerFilter} onChange={event => setProviderFilter(event.target.value)}>
            <option value="">全部 Provider</option>{['claude', 'codex', 'qoder', 'opencode', 'pi'].map(provider => <option key={provider}>{provider}</option>)}
          </select>
          <span>最近 30 天 · 最多 1000 轮</span>
        </div>
        {loading && <p role="status">正在读取测速历史…</p>}
        {error && <p role="alert">测速历史不可用：{error}</p>}
        {!loading && !error && history && comparisons.length === 0 && <p>暂无匹配的测速历史。给下次运行设置网络标签，然后正常发送消息即可。</p>}
        {!error && comparisons.length > 0 && <div className="llm-performance-table-wrap">
          <table className="llm-performance-table">
            <thead><tr><th>网络 / Provider</th><th>模型</th><th>轮数 / 失败或停止</th><th>首次输出中位数</th><th>接收均速中位数</th><th>API 吞吐中位数</th></tr></thead>
            <tbody>{comparisons.map(row => <tr key={row.key}>
              <td>{row.networkLabel || '未标注'}<small>{row.providerId}{row.agentProfileId ? ` · ${row.agentProfileId}` : ''}</small></td>
              <td>{row.model}{row.upstreamProvider && <small>{row.upstreamProvider}</small>}</td>
              <td>{row.runs} / {row.failedRuns}</td>
              <td>{number(row.medianWaitMs == null ? undefined : row.medianWaitMs / 1000, 's')}<small>{row.waitSamples} 轮有数据</small></td>
              <td>{number(row.medianCharactersPerSecond, '字符/s')}<small>{row.speedSamples} 轮有数据</small></td>
              <td>{number(row.medianApiTokensPerSecond, 'tok/s')}<small>{row.apiSamples} 轮有数据</small></td>
            </tr>)}</tbody>
          </table>
        </div>}
        {history && (history.invalidLines > 0 || history.truncated) && <p role="status">历史为部分证据：{history.truncated ? '仅保留本次视图最近 1000 轮；' : ''}{history.invalidLines > 0 ? `${history.invalidLines} 行损坏或不支持，未参与对比。` : ''}</p>}
        <p className="llm-performance-note">中位数不含失败或停止轮次。API 吞吐仅在 Provider 同时提供输出量和 API 耗时时可用，不与字符速度混算。厂商身份来自明确的 upstream 证据，Provider 不等于厂商。固定提示词、上下文量、缓存和推理设置再多次采样；网络标签不证明 VPN 实际生效，也不能单独证明网络造成快慢。</p>
      </div>}
    </section>
  )
}
