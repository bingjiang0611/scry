import { useState } from 'react'
import { useFirstReadyList } from '../hooks/useFirstReadyList'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { LoadingStatus } from './LoadingStatus'
import type { UsageAnalytics, UsageAnalyticsBreakdownRow, UsageAnalyticsRangeDays } from '@shared/trace'
import { Icon } from './primitives/Icon'
import { ANALYTICS_COPY as copy } from '../constants/copy'
import { formatAggregateTokens, formatCost, formatDay, formatKnownTokens, formatShare, metricValue, metricEvidence, modelBreakdownRows, tokensOf, ProviderMark, providerLabel, displayCostEvidence, tokenEvidence, tokenComplete, isApproximateCost, usdFormatter, ranges, UsageChart, type BreakdownMode, type ChartMetric } from './AnalyticsChart'
export interface AnalyticsViewProps {
  analytics: UsageAnalytics | null
  rangeDays: UsageAnalyticsRangeDays
  loading: boolean
  error: string | null
  onRangeChange: (rangeDays: UsageAnalyticsRangeDays) => void
  onRefresh: () => void
  onBack?: () => void
}

export function AnalyticsView({ analytics, rangeDays, loading, error, onRangeChange, onRefresh, onBack }: AnalyticsViewProps) {
  const [chartMetric, setChartMetric] = useState<ChartMetric>('cost')
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>('model')
  const breakdownMotion = useFirstReadyList(Boolean(analytics?.status === 'ready'))
  const showLoading = useDelayedFlag(loading)

  if (!analytics && loading) {
    return <main className="usage-page" aria-busy="true">{showLoading && <LoadingStatus className="usage-state" title={copy.loading} />}</main>
  }
  if (!analytics || analytics.status !== 'ready') {
    return (
      <main className="usage-page">
        <div className="usage-state is-error">
          <Icon name="alert" />
          <div><b>{copy.unavailable}</b><span>{error ?? copy.databaseUnavailable}</span></div>
          <button type="button" onClick={onRefresh}>{copy.retry}</button>
        </div>
      </main>
    )
  }

  const totals = analytics.totals
  const providers = analytics.byProvider.filter((row) => row.usageRows > 0 || row.costKnownRows > 0 || row.qoderCredits)
  const costProviders = providers.filter((row) => row.costUsd != null).sort((a, b) => b.costUsd! - a.costUsd!)
  const qoderOnly = providers.length > 0 && providers.every((row) => row.provider === 'qoder')
  const chartProviders = providers.filter((row) => metricValue(row, chartMetric) != null)
  const rows = breakdownMode === 'model' ? modelBreakdownRows(analytics) : analytics.byDay.filter((row) => row.costUsd != null).reverse()
  const totalEvidence = copy.totalEvidence(displayCostEvidence(totals), totals.turns)
  const metrics = [
    { label: copy.processedTokens, value: formatAggregateTokens(totals), evidence: tokenEvidence(totals) },
    { label: copy.cacheRead, value: formatKnownTokens(totals.cacheReadTokens), evidence: copy.tokenCoverage(totals.cacheReadKnownRows, totals.usageRows) },
    { label: copy.input, value: formatKnownTokens(totals.inputTokens), evidence: copy.tokenCoverage(totals.inputKnownRows, totals.usageRows) },
    { label: copy.output, value: formatKnownTokens(totals.outputTokens), evidence: copy.outputEvidence(totals.outputKnownRows, totals.usageRows, formatKnownTokens(totals.reasoningTokens)) },
    { label: copy.cacheWrite, value: formatKnownTokens(totals.cacheWriteTokens), evidence: copy.tokenCoverage(totals.cacheWriteKnownRows, totals.usageRows) }
  ]

  return (
    <main className="usage-page">
      <div className="usage-shell">
        <header className="usage-header">
          <div className="usage-title-group">
            {onBack && (
              <button className="usage-back" type="button" onClick={onBack} aria-label={copy.back} title={copy.back}>
                <Icon name="chevronRight" />
              </button>
            )}
            <div>
              <h1>{copy.title}</h1>
              <p title={copy.period(analytics.fromDay, analytics.toDay)}>{copy.periodDisplay(formatDay(analytics.fromDay), formatDay(analytics.toDay))}</p>
            </div>
          </div>
          <div className="usage-actions">
            <div className="usage-segmented" role="group" aria-label={copy.rangeLabel}>
              {ranges.map((days) => (
                <button type="button" key={days} className={rangeDays === days ? 'active' : ''} aria-pressed={rangeDays === days} onClick={() => onRangeChange(days)}>{copy.range(days)}</button>
              ))}
            </div>
            <button className={`usage-refresh ${showLoading ? 'is-loading' : ''}`} type="button" onClick={onRefresh} disabled={loading} aria-label={copy.refresh} title={copy.refresh}>
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {error && <div className="usage-inline-error" role="status">{error}</div>}

        <section className="usage-overview" aria-label={copy.overview}>
          <article className="usage-cost-card" aria-label={copy.totalLabel} aria-description={totalEvidence}>
            <h2 className="usage-eyebrow">{copy.totalLabel}</h2>
            <strong title={totalEvidence}>
              {totals.costUsd == null || (totals.costUsd > 0 && totals.costUsd < 0.01)
                ? formatCost(totals.costUsd)
                : usdFormatter.formatToParts(totals.costUsd).map((part, index) => (
                  <span className={`usage-cost-${part.type}`} key={index}>{part.value}</span>
                ))}
            </strong>
          </article>
          <article className="usage-composition" aria-label={copy.composition}>
            <h2>{copy.composition}</h2>
            <div className="usage-composition-bar" role="img" aria-label={copy.compositionChart}>
              {costProviders.map((row) => (
                <span key={row.provider} className={`is-${row.provider}`} title={providerLabel(row.provider)}
                  style={{ flexBasis: `${totals.costUsd != null && totals.costUsd > 0 ? row.costUsd! / totals.costUsd * 100 : 0}%` }} />
              ))}
            </div>
            <div className="usage-composition-key">
              {costProviders.map((row) => (
                <div key={row.provider}>
                  <span><ProviderMark provider={row.provider} />{providerLabel(row.provider)}</span>
                  <strong>{formatShare(row.costUsd, totals.costUsd)}</strong>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="usage-analysis">
          <article className="usage-chart-card">
            <div className="usage-section-head usage-chart-head">
              <h2>{chartMetric === 'cost' ? copy.dailyCost : copy.dailyTokens}</h2>
              <div className="usage-segmented is-compact" role="group" aria-label={copy.metric}>
                <button type="button" className={chartMetric === 'cost' ? 'active' : ''} aria-pressed={chartMetric === 'cost'} onClick={() => setChartMetric('cost')}>{copy.cost}</button>
                <button type="button" className={chartMetric === 'tokens' ? 'active' : ''} aria-pressed={chartMetric === 'tokens'} onClick={() => setChartMetric('tokens')}>{copy.tokenToggle}</button>
              </div>
            </div>
            <div className="usage-legend" aria-label={copy.legend}>
              {chartProviders.map((row) => (
                <span key={row.provider} title={metricEvidence(row, chartMetric)}>
                  <ProviderMark provider={row.provider} />{providerLabel(row.provider)}
                </span>
              ))}
            </div>
            <UsageChart key={`${chartMetric}:${analytics.fromDay}:${analytics.toDay}`} analytics={analytics} metric={chartMetric} />
          </article>
          <article className="usage-provider-panel" aria-label={copy.byProvider}>
            <div className="usage-section-head"><h2>{copy.byProvider}</h2></div>
            <div className="usage-provider-list">
              {costProviders.length === 0 ? <div className="usage-empty-row">{copy.noCost}</div> : costProviders.map((row) => (
                <div className="usage-provider-row" key={row.provider}>
                  <div className="usage-provider-main">
                    <ProviderMark provider={row.provider} />
                    <b>{providerLabel(row.provider)}</b>
                    <span className="usage-provider-share">{formatShare(row.costUsd, totals.costUsd)}</span>
                    <strong title={copy.providerEvidence(displayCostEvidence(row, row.provider), formatAggregateTokens(row), tokenEvidence(row))}>{formatCost(row.costUsd)}</strong>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="usage-tokens" aria-label={copy.tokens}>
          <h2>{copy.tokens}</h2>
          <dl className="usage-metrics">
            {metrics.map((metric) => (
              <div key={metric.label} title={metric.evidence}>
                <dt>{metric.label}</dt><dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="usage-breakdown">
          <div className="usage-section-head">
            <h2>{copy.details}</h2>
            <div className="usage-segmented is-compact" role="group" aria-label={copy.detailDimension}>
              <button type="button" className={breakdownMode === 'model' ? 'active' : ''} aria-pressed={breakdownMode === 'model'} onClick={() => setBreakdownMode('model')}>{copy.model}</button>
              <button type="button" className={breakdownMode === 'day' ? 'active' : ''} aria-pressed={breakdownMode === 'day'} onClick={() => setBreakdownMode('day')}>{copy.day}</button>
            </div>
          </div>
          <div className="usage-table-wrap">
            <table>
              <colgroup><col className="usage-model-column" /><col className="usage-cost-column" /><col /><col /></colgroup>
              <thead><tr><th scope="col">{breakdownMode === 'model' ? copy.model : copy.day}</th><th scope="col">{copy.costUsd}</th><th scope="col">{copy.share}</th><th scope="col">{copy.token}</th></tr></thead>
              <tbody className={breakdownMotion.className}>
                {rows.length === 0 ? (
                  <tr><td colSpan={4}>{copy.noDetails}</td></tr>
                ) : rows.map((row, index) => {
                  const modelRow = row as UsageAnalyticsBreakdownRow
                  const key = breakdownMode === 'model' ? `${modelRow.provider}:${modelRow.model ?? ''}` : (row as typeof analytics.byDay[number]).day
                  const label = breakdownMode === 'model'
                    ? modelRow.provider === 'qoder' ? providerLabel('qoder') : modelRow.model ?? copy.unattributed
                    : (row as typeof analytics.byDay[number]).day
                  const rowProvider = breakdownMode === 'model' ? modelRow.provider : qoderOnly ? 'qoder' : undefined
                  return (
                    <tr key={key} className="motion-stagger-item" style={breakdownMotion.itemStyle(index)}>
                      <th scope="row">
                        <span className="usage-model-cell">
                          {breakdownMode === 'model' ? <ProviderMark provider={modelRow.provider} /> : <Icon name="clock" />}
                          <b title={label}>{label}</b>
                        </span>
                      </th>
                      <td title={displayCostEvidence(row, rowProvider)} className={isApproximateCost(row) ? 'is-approximate' : undefined}>{formatCost(row.costUsd)}</td>
                      <td>{totals.costUsd != null && totals.costUsd > 0 ? formatShare(row.costUsd, totals.costUsd) : null}</td>
                      <td title={tokenEvidence(row)} className={!tokenComplete(row) && row.usageRows > 0 ? 'is-lower-bound' : undefined}>{tokensOf(row) != null ? formatAggregateTokens(row) : null}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </main>
  )
}
