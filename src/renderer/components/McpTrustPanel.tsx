import { useMemo, useState } from 'react'
import type { McpLiveStatus } from '@shared/trace'
import type { RuntimeProvider } from '@shared/runtime'
import type { McpMeta } from '../env'
import { Icon } from './primitives/Icon'

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
type TrustTone = 'ok' | 'warn' | 'bad' | 'muted'

export interface McpGuardTarget {
  targetId: string
  serverName: string
  client?: string
  scope?: string
  transport?: string
  sourceType?: string
  sourcePath?: string
  command?: string
  args?: string[]
  url?: string
  package?: string
  version?: string
  repository?: string
  envKeys?: string[]
  roots?: string[]
  toolFingerprints?: Array<{ name: string; changed?: boolean }>
  enabled?: boolean
  introspection?: { status?: string; reason?: string }
}

export interface McpGuardFinding {
  findingInstanceId: string
  title: string
  severity: Severity
  confidence?: string
  affectedTargets?: Array<{ targetId: string; role?: string }>
  rule?: { id?: string; version?: string; source?: string }
  category?: string
  policy?: { profile?: string; decision?: 'block' | 'warn' | 'pass'; exceptionId?: string | null }
  recommendation?: string
}

export interface McpGuardReport {
  schemaVersion: string
  scan: {
    id?: string
    tool?: string
    toolVersion?: string
    ruleVersion?: string
    startedAt?: string
    mcpSpecVersion?: string
    mode?: string
    offline?: boolean
    redactionPolicy?: string
  }
  targets: McpGuardTarget[]
  summary: Partial<Record<Severity, number>> & { status?: 'pass' | 'warn' | 'block' }
  sessionAuthPosture?: { status?: string; missingAuthCount?: number | null; items?: unknown[] }
  findings: McpGuardFinding[]
  audit?: { reportHash?: string; signedBundle?: unknown; generatedFor?: string }
  errors?: string[]
  skipped?: Array<{ targetId?: string; reason?: string }>
}

interface TrustLabel {
  key: string
  label: string
  tone: TrustTone
  detail: string
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && value in SEVERITY_ORDER
}

function isPolicyStatus(value: unknown): value is 'pass' | 'warn' | 'block' {
  return value === 'pass' || value === 'warn' || value === 'block'
}

function isMcpGuardTarget(value: unknown): value is McpGuardTarget {
  return isRecord(value) && typeof value.targetId === 'string' && typeof value.serverName === 'string'
}

function isMcpGuardFinding(value: unknown): value is McpGuardFinding {
  return (
    isRecord(value) &&
    typeof value.findingInstanceId === 'string' &&
    typeof value.title === 'string' &&
    isSeverity(value.severity)
  )
}

function isMcpGuardReport(value: unknown): value is McpGuardReport {
  if (!isRecord(value)) return false
  const scan = value.scan
  const summary = value.summary
  const targets = value.targets
  const findings = value.findings
  return (
    value.schemaVersion === '0.1' &&
    isRecord(scan) &&
    scan.tool === 'mcpguard' &&
    Array.isArray(targets) &&
    targets.every(isMcpGuardTarget) &&
    Array.isArray(findings) &&
    findings.every(isMcpGuardFinding) &&
    isRecord(summary) &&
    (summary.status == null || isPolicyStatus(summary.status))
  )
}

function count(summary: McpGuardReport['summary'], severity: Severity): number {
  const value = summary[severity]
  return typeof value === 'number' ? value : 0
}

function severityTone(severity: Severity): TrustTone {
  if (severity === 'critical' || severity === 'high') return 'bad'
  if (severity === 'medium') return 'warn'
  return 'muted'
}

function policyTone(decision?: string): TrustTone {
  if (decision === 'block') return 'bad'
  if (decision === 'warn') return 'warn'
  if (decision === 'pass') return 'ok'
  return 'muted'
}

function statusTone(status?: string): TrustTone {
  if (status === 'connected') return 'ok'
  if (status === 'needs-auth' || status === 'pending') return 'warn'
  if (status === 'failed') return 'bad'
  return 'muted'
}

function severityLabel(severity: Severity): string {
  if (severity === 'critical') return '严重'
  if (severity === 'high') return '高'
  if (severity === 'medium') return '中'
  if (severity === 'low') return '低'
  return '信息'
}

function decisionLabel(decision?: string): string {
  if (decision === 'block') return '阻断'
  if (decision === 'warn') return '警告'
  if (decision === 'pass') return '通过'
  return '未判定'
}

function liveStatusLabel(status: McpLiveStatus['status']): string {
  if (status === 'connected') return '已连接'
  if (status === 'needs-auth') return '需授权'
  if (status === 'failed') return '失败'
  if (status === 'pending') return '探测中'
  return '已禁用'
}

function shortPath(value?: string): string {
  if (!value) return '—'
  const home = value.replace(/^\/Users\/[^/]+/, '~')
  if (home.length <= 44) return home
  return `…${home.slice(-43)}`
}

function targetFindings(report: McpGuardReport, targetId: string): McpGuardFinding[] {
  return report.findings.filter((finding) => finding.affectedTargets?.some((target) => target.targetId === targetId))
}

function targetName(report: McpGuardReport, targetId?: string): string {
  if (!targetId) return 'unknown'
  return report.targets.find((target) => target.targetId === targetId)?.serverName ?? targetId
}

function buildReportLabels(report: McpGuardReport): TrustLabel[] {
  const blocked = report.summary.status === 'block'
  const warned = report.summary.status === 'warn'
  return [
    {
      key: 'scanned',
      label: 'scanned',
      tone: 'ok',
      detail: `${report.scan.mode ?? 'static'} · ${report.scan.offline ? 'offline' : 'online'} · ${report.targets.length} servers`
    },
    {
      key: 'policy-pass',
      label: 'policy-pass',
      tone: blocked ? 'bad' : warned ? 'warn' : 'ok',
      detail: blocked ? '存在阻断级策略' : warned ? '存在警告或未观察项' : '未发现阻断项'
    },
    {
      key: 'sandbox-ready',
      label: 'sandbox-ready',
      tone: 'muted',
      detail: '未提供 sandbox attestation'
    },
    {
      key: 'supply-chain-reviewed',
      label: 'supply-chain-reviewed',
      tone: 'muted',
      detail: '未提供供应链审查证据'
    },
    {
      key: 'enterprise-reviewed',
      label: 'enterprise-reviewed',
      tone: 'muted',
      detail: '未接入企业签发证据'
    }
  ]
}

function buildTargetLabels(report: McpGuardReport, target: McpGuardTarget): TrustLabel[] {
  const findings = targetFindings(report, target.targetId)
  const blocked = findings.some((finding) => finding.policy?.decision === 'block')
  const warned = findings.some((finding) => finding.policy?.decision === 'warn')
  const skipped = report.skipped?.some((item) => item.targetId === target.targetId)
  return [
    {
      key: 'scanned',
      label: 'scanned',
      tone: target.enabled === false ? 'muted' : 'ok',
      detail: target.enabled === false ? 'server disabled' : `${report.scan.mode ?? 'static'} scan`
    },
    {
      key: 'policy-pass',
      label: 'policy-pass',
      tone: blocked ? 'bad' : warned || skipped ? 'warn' : 'ok',
      detail: blocked ? '存在 block finding' : warned ? '存在 warn finding' : skipped ? '存在未观察项' : '未命中 block/warn'
    },
    {
      key: 'sandbox-ready',
      label: 'sandbox-ready',
      tone: 'muted',
      detail: '静态扫描不执行 server'
    },
    {
      key: 'supply-chain-reviewed',
      label: 'supply-chain-reviewed',
      tone: 'muted',
      detail: target.repository || target.package ? '仅发现来源字段，未审查' : '缺少来源证据'
    }
  ]
}

function trustSummary(report: McpGuardReport) {
  const criticalHigh = count(report.summary, 'critical') + count(report.summary, 'high')
  const policyBlocks = report.findings.filter((finding) => finding.policy?.decision === 'block').length
  return { criticalHigh, policyBlocks }
}

function sortedFindings(report: McpGuardReport): McpGuardFinding[] {
  return [...report.findings].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
    if (severityDelta !== 0) return severityDelta
    return (a.rule?.id ?? '').localeCompare(b.rule?.id ?? '')
  })
}

export function McpTrustPanel({
  report = null,
  scanning = false,
  refreshing = false,
  onScan,
  onRefreshLive,
  onReportChange,
  runtimeProvider = 'claude_sdk',
  mcpLive = [],
  mcps = []
}: {
  report?: McpGuardReport | null
  scanning?: boolean
  refreshing?: boolean
  onScan?: () => Promise<unknown>
  onRefreshLive?: () => Promise<unknown> | void
  onReportChange?: (report: McpGuardReport) => void
  runtimeProvider?: RuntimeProvider
  mcpLive?: McpLiveStatus[]
  mcps?: McpMeta[]
}) {
  const [error, setError] = useState<string | null>(null)
  const liveByName = useMemo(() => new Map(mcpLive.map((item) => [item.name, item])), [mcpLive])
  const missingAuth = mcpLive.filter((item) => item.status === 'needs-auth')
  const failedLive = mcpLive.filter((item) => item.status === 'failed')
  const pendingLive = mcpLive.filter((item) => item.status === 'pending')
  const attentionLive = [...missingAuth, ...failedLive, ...pendingLive]
  const runtimeName =
    runtimeProvider === 'qoder_cli'
      ? 'Qoder'
      : runtimeProvider === 'codex_cli'
        ? 'Codex'
        : runtimeProvider === 'opencode_server'
          ? 'OpenCode'
          : 'Claude Code'
  const configuredButSilent =
    runtimeProvider === 'claude_sdk' ? mcps.filter((mcp) => mcp.enabled && !liveByName.has(mcp.name)) : []
  const labels = useMemo(() => (report ? buildReportLabels(report) : []), [report])
  const summary = useMemo(() => (report ? trustSummary(report) : null), [report])
  const findings = useMemo(() => (report ? sortedFindings(report).slice(0, 8) : []), [report])
  const targetRows = useMemo(() => {
    if (!report) return []
    return [...report.targets]
      .sort((a, b) => {
        const af = targetFindings(report, a.targetId)
        const bf = targetFindings(report, b.targetId)
        const as = Math.max(0, ...af.map((finding) => SEVERITY_ORDER[finding.severity]))
        const bs = Math.max(0, ...bf.map((finding) => SEVERITY_ORDER[finding.severity]))
        return bs - as || a.serverName.localeCompare(b.serverName)
      })
      .slice(0, 10)
  }, [report])

  const acceptReport = (parsed: unknown, prefix: string): void => {
    if (!isMcpGuardReport(parsed)) {
      setError(`${prefix}失败：不是 mcpguard scan JSON`)
      return
    }
    if (onReportChange) onReportChange(parsed)
    else setError(`${prefix}失败：面板未连接报告状态`)
  }

  const scanReport = async (): Promise<void> => {
    if (!onScan) {
      setError('扫描失败：面板未连接 mcpguard 扫描器')
      return
    }
    setError(null)
    try {
      acceptReport(await onScan(), '扫描')
    } catch (err) {
      setError(`扫描失败：${err instanceof Error ? err.message : 'mcpguard 扫描异常'}`)
    }
  }

  return (
    <div className="panel-section mcp-trust-section">
      <h4>
        MCP 信任
        <span className="more">{report ? `${report.targets.length} servers` : '等待报告'}</span>
      </h4>
      <div className="mcp-trust-actions">
        <button
          className="billing-sync fixture"
          type="button"
          disabled={refreshing || !onRefreshLive}
          onClick={() => void onRefreshLive?.()}
          title="拉取当前运行时可见的 MCP live 状态"
        >
          <Icon name="refresh" /> {refreshing ? '刷新中…' : '刷新 MCP 状态'}
        </button>
        <button
          className="billing-sync"
          type="button"
          disabled={scanning || !onScan}
          onClick={scanReport}
          title={onScan ? '扫描当前 Provider 的 MCP 配置' : '当前 Provider 尚未接入 MCP Guard 扫描'}
        >
          <Icon name="refresh" /> {scanning ? '扫描中…' : '扫描当前 MCP'}
        </button>
      </div>
      {error && <div className="mcp-trust-error">{error}</div>}

      <details className="billing-details" open>
        <summary>
          运行时 MCP <span>{mcpLive.length ? `${mcpLive.length} live` : runtimeName}</span>
        </summary>
        {missingAuth.length > 0 && (
          <div className="mcp-auth-banner">
            <Icon name="alert" /> {missingAuth.length} 个 MCP server 需要授权 · 按当前运行时处理
          </div>
        )}
        {attentionLive.slice(0, 8).map((item) => (
          <div className="billing-row" key={`${item.name}-${item.status}`} title={item.serverVersion ?? item.name}>
            <span className={`sdot ${statusTone(item.status)}`} />
            <span className="fname">{item.name}</span>
            <span className="dim">
              {liveStatusLabel(item.status)}
              {item.tools != null ? ` · ${item.tools} tools` : ''}
            </span>
          </div>
        ))}
        {missingAuth.length === 0 && failedLive.length === 0 && pendingLive.length === 0 && mcpLive.length > 0 && (
          <div className="dim pad2">当前捕获的 MCP live 状态无授权缺口。</div>
        )}
        {mcpLive.length === 0 && <div className="dim pad2">{runtimeName} 暂无逐项 MCP live 状态；可发起会话或刷新后重试。</div>}
        {configuredButSilent.length > 0 && (
          <div className="psrc">配置中启用但未被当前运行时 live 捕获：{configuredButSilent.slice(0, 4).map((m) => m.name).join(' · ')}</div>
        )}
      </details>

      {report && (
        <>
          <div className="billing-grid mcp-trust-grid">
            <div>
              <span>策略状态</span>
              <b className={`trust-text ${policyTone(report.summary.status)}`}>{decisionLabel(report.summary.status)}</b>
            </div>
            <div>
              <span>高危发现</span>
              <b>{summary?.criticalHigh ?? 0}</b>
            </div>
            <div>
              <span>阻断策略</span>
              <b>{summary?.policyBlocks ?? 0}</b>
            </div>
            <div>
              <span>审计哈希</span>
              <b title={report.audit?.reportHash}>{report.audit?.reportHash ? shortPath(report.audit.reportHash) : '—'}</b>
            </div>
          </div>

          <div className="mcp-labels">
            {labels.map((label) => (
              <span className={`trust-label ${label.tone}`} key={label.key} title={label.detail}>
                {label.label}
              </span>
            ))}
          </div>
          <div className="psrc">
            来源 {report.scan.id ?? 'scan'} · rule {report.scan.ruleVersion ?? 'unknown'} · {report.audit?.generatedFor ?? 'local-only'}；标签只代表报告证据，不是官方认证。
          </div>

          <details className="billing-details" open>
            <summary>
              风险发现 <span>{report.findings.length}</span>
            </summary>
            {SEVERITIES.some((severity) => count(report.summary, severity) > 0) && (
              <div className="mcp-severity-strip">
                {SEVERITIES.map((severity) => (
                  <span className={`trust-label ${severityTone(severity)}`} key={severity}>
                    {severityLabel(severity)} {count(report.summary, severity)}
                  </span>
                ))}
              </div>
            )}
            {findings.length === 0 ? (
              <div className="dim pad2">未发现风险项。</div>
            ) : (
              findings.map((finding) => {
                const target = targetName(report, finding.affectedTargets?.[0]?.targetId)
                return (
                  <div className="mcp-finding" key={finding.findingInstanceId} title={finding.recommendation}>
                    <span className={`trust-label ${severityTone(finding.severity)}`}>{severityLabel(finding.severity)}</span>
                    <span className="fname">{finding.title}</span>
                    <span className="dim">
                      {finding.rule?.id ?? 'rule'} · {target} · {decisionLabel(finding.policy?.decision)}
                    </span>
                  </div>
                )
              })
            )}
          </details>

          <details className="billing-details" open>
            <summary>
              Fleet inventory <span>{report.targets.length}</span>
            </summary>
            {targetRows.map((target) => {
              const findingsForTarget = targetFindings(report, target.targetId)
              const high = findingsForTarget.filter((finding) => SEVERITY_ORDER[finding.severity] >= SEVERITY_ORDER.high).length
              return (
                <div className="mcp-target" key={target.targetId}>
                  <div className="mcp-target-head">
                    <span className="fname" title={target.serverName}>
                      {target.serverName}
                    </span>
                    <span className={`trust-label ${target.enabled === false ? 'muted' : high > 0 ? 'bad' : findingsForTarget.length ? 'warn' : 'ok'}`}>
                      {target.enabled === false ? 'disabled' : high > 0 ? `${high} high+` : findingsForTarget.length ? `${findingsForTarget.length} warn` : 'clean'}
                    </span>
                  </div>
                  <div className="dim">
                    {target.transport ?? 'unknown'} · {target.scope ?? 'unknown'} · {target.toolFingerprints?.length ?? 0} tools · env{' '}
                    {target.envKeys?.length ?? 0} · roots {target.roots?.length ?? 0}
                  </div>
                  <div className="psrc" title={target.sourcePath}>
                    {shortPath(target.sourcePath)}
                  </div>
                  <div className="mcp-labels compact">
                    {buildTargetLabels(report, target).map((label) => (
                      <span className={`trust-label ${label.tone}`} key={label.key} title={label.detail}>
                        {label.label}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </details>

          <details className="billing-details">
            <summary>
              策略与审计 <span>{(report.errors?.length ?? 0) + (report.skipped?.length ?? 0)} notes</span>
            </summary>
            <div className="billing-row">
              <span className="fname">扫描模式</span>
              <span className="dim">
                {report.scan.mode ?? 'static'} · {report.scan.offline ? 'offline' : 'online'} · spec {report.scan.mcpSpecVersion ?? 'unknown'}
              </span>
            </div>
            <div className="billing-row">
              <span className="fname">会话授权姿态</span>
              <span className="dim">
                {report.sessionAuthPosture?.status ?? 'not_analyzed'} · missing{' '}
                {report.sessionAuthPosture?.missingAuthCount ?? '—'}
              </span>
            </div>
            <div className="billing-row">
              <span className="fname">跳过项</span>
              <span className="dim">{report.skipped?.length ?? 0}</span>
            </div>
            <div className="billing-row">
              <span className="fname">错误</span>
              <span className="dim">{report.errors?.length ?? 0}</span>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
