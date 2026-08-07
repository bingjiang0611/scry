// Diagnostics evidence workspace: verdict first, prioritized issues second, source evidence last.
// Every value below comes from the current renderer props; unknown, unsupported, partial, and true zero stay distinct.
import { useMemo, useState } from 'react'
import type { DbStats, Diagnostics, McpLiveStatus, UsageStats } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import type { DetectedAgent, McpMeta, ProjectMeta } from '../env'
import { fmtTok } from '../format'
import type { Turn } from '../format'
import { Icon } from './primitives/Icon'

type EvidenceState = 'exact' | 'partial' | 'unknown' | 'unsupported' | 'true-zero' | 'warn' | 'error'

interface RuntimeCapabilityWarningView {
  kind: string
  runtimeProvider: string
  name: string
  reason: string
  ts?: string
  expected?: string
  observed?: string
  evidence?: string
}

interface DiagnosticEvidenceEvent {
  when: string
  source: string
  finding: string
  state: EvidenceState
}

interface DiagnosticIssue {
  id: string
  state: EvidenceState
  title: string
  summary: string
  value: string
  action: string
  attention: boolean
  evidence: DiagnosticEvidenceEvent[]
}

const STATE_LABEL: Record<EvidenceState, string> = {
  exact: '完整',
  partial: '部分覆盖',
  unknown: '未知',
  unsupported: '未支持',
  'true-zero': '真实 0',
  warn: '需注意',
  error: '失败'
}

const STATE_RANK: Record<EvidenceState, number> = {
  error: 0,
  warn: 1,
  partial: 2,
  unknown: 3,
  unsupported: 4,
  exact: 5,
  'true-zero': 6
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
          ts: item.ts,
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

function statusForMcp(status: McpLiveStatus['status']): EvidenceState {
  if (status === 'connected' || status === 'disabled') return 'exact'
  if (status === 'pending') return 'partial'
  if (status === 'failed') return 'error'
  return 'warn'
}

function StatusMark({ state, label }: { state: EvidenceState; label?: string }) {
  return (
    <span className={`de-status de-status-${state}`}>
      <i />
      {label ?? STATE_LABEL[state]}
    </span>
  )
}

function KnownValue({ value, state }: { value: string; state: EvidenceState }) {
  const display = state === 'unknown' ? '—' : state === 'unsupported' ? '未支持' : value
  return (
    <span className={`de-known de-known-${state}`} data-state={state} title={STATE_LABEL[state]}>
      {display}
    </span>
  )
}

export function DiagnosticsView({
  agents,
  diag,
  mcpLive,
  mcps,
  mcpCapability = null,
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
  mcpCapability?: CapabilityEnvelope<McpSnapshot> | null
  stats: DbStats | null
  turns: Turn[]
  projects: ProjectMeta[]
  usage: UsageStats | null
  onReprobe: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sessionCount = projects.reduce((sum, project) => sum + project.sessions.length, 0)
  const usageReady = usage?.status === 'ready'
  const usageAvailable = usageReady || usage?.status === 'partial'
  const dbReady = stats?.status === 'ready'
  const runtimeWarnings = useMemo(() => runtimeWarningsFromTurns(turns), [turns])
  const resultItems = turns.flatMap((turn) =>
    turn.items.filter((item) => item.kind === 'harness' && item.stage === 'result')
  )
  const resultCount = resultItems.length
  const explicitCapabilityResults = resultItems.filter((item) =>
    Array.isArray(item.runtimeMetadata?.capabilityWarnings)
  )
  const unsupportedCapabilityResults = resultItems.filter(
    (item) => !Array.isArray(item.runtimeMetadata?.capabilityWarnings) && item.runtimeProvider === 'claude_sdk'
  )
  const unknownCapabilityResults = resultItems.filter(
    (item) => !Array.isArray(item.runtimeMetadata?.capabilityWarnings) && item.runtimeProvider !== 'claude_sdk'
  )
  const sessionDangers = useMemo(
    () => turns.flatMap((turn) => turn.items).filter((item) => item.danger && item.stage !== 'tool_result'),
    [turns]
  )
  const dangerTrend = dbReady ? stats.dangerTrend : []
  const trendDanger = dangerTrend
    .filter((entry) => entry.level === 'danger')
    .reduce((sum, entry) => sum + entry.n, 0)
  const trendWarn = dangerTrend
    .filter((entry) => entry.level === 'warn')
    .reduce((sum, entry) => sum + entry.n, 0)
  const trendTotal = trendDanger + trendWarn
  const sampledDangerCoverage = dbReady ? (stats.providerCoverage ?? []).filter((entry) => entry.turns > 0) : []
  const classifiedDangerCoverage = sampledDangerCoverage.filter((entry) => entry.dangerCoverage === 'classified')
  const unsupportedDangerCoverage = sampledDangerCoverage.filter((entry) => entry.dangerCoverage === 'unsupported')

  const unavailableAgents = agents.filter((agent) => agent.health?.state === 'unavailable')
  const degradedAgents = agents.filter((agent) => agent.health?.state === 'degraded')
  const unknownAgents = agents.filter((agent) => agent.health?.state === 'unknown')
  const agentState: EvidenceState =
    agents.length === 0 || unavailableAgents.length > 0
      ? 'error'
      : degradedAgents.length > 0
        ? 'partial'
        : unknownAgents.length > 0
          ? 'unknown'
          : 'exact'
  const agentSummary =
    agents.length === 0
      ? 'PATH 中未找到已注册的 Agent executable。'
      : agents
          .map((agent) => `${agent.name} ${agent.version ?? agent.transport ?? '版本未上报'}`)
          .join(' · ')

  const agentIssue: DiagnosticIssue = {
    id: 'providers',
    state: agentState,
    title: agents.length === 0 ? '未检测到 Provider' : `检测到 ${agents.length} 个 Provider`,
    summary: agentSummary,
    value: agents.length === 0 ? '—' : String(agents.length),
    action: agents.length === 0 ? '检查登录 shell PATH 与 Provider CLI 安装。' : '无需处置；路径或版本变化时重新探测。',
    attention: agentState !== 'exact',
    evidence:
      agents.length === 0
        ? [{ when: '启动探测', source: 'Provider locator', finding: '未返回可执行文件', state: 'error' }]
        : agents.map((agent) => ({
            when: '启动探测',
            source: agent.name,
            finding: `${agent.path || '路径未上报'} · ${agent.version ?? agent.transport ?? '版本未上报'}${
              agent.health?.state ? ` · health ${agent.health.state}` : ''
            }`,
            state:
              agent.health?.state === 'unavailable'
                ? 'error'
                : agent.health?.state === 'degraded'
                  ? 'partial'
                  : agent.health?.state === 'unknown'
                    ? 'unknown'
                    : 'exact'
          }))
  }

  const diagnosticsIssue: DiagnosticIssue = {
    id: 'diagnostics-ipc',
    state: diag ? 'exact' : 'unknown',
    title: diag ? '诊断 IPC 已返回' : '诊断 IPC 尚未返回',
    summary: diag
      ? diag.claudeVersion
        ? `最近一次 Claude runtime 报告版本 ${diag.claudeVersion}。`
        : '主进程已返回诊断对象；当前对象没有 Claude runtime 版本字段。'
      : '没有可验证的诊断对象；可点重新探测。',
    value: diag ? 'ready' : '—',
    action: diag ? '无需处置。' : '重新探测；若仍为空，检查 diagnostics IPC。',
    attention: !diag,
    evidence: [
      diag
        ? {
            when: '当前快照',
            source: 'diagnostics IPC',
            finding: diag.claudeVersion ? `Claude runtime ${diag.claudeVersion}` : '诊断对象已返回；Claude runtime 版本未上报',
            state: diag.claudeVersion ? 'exact' : 'unknown'
          }
        : { when: '当前快照', source: 'diagnostics IPC', finding: '返回值为空', state: 'unknown' }
    ]
  }

  const mcpFailed = mcpLive.filter((entry) => entry.status === 'failed')
  const mcpAuth = mcpLive.filter(
    (entry) => entry.status === 'needs-auth' || entry.status === 'needs-client-registration'
  )
  const mcpPending = mcpLive.filter((entry) => entry.status === 'pending')
  const mcpConnected = mcpLive.filter((entry) => entry.status === 'connected')
  const mcpDisabled = mcps.filter((entry) => !entry.enabled)
  const enabledMcpCount = mcps.length - mcpDisabled.length
  const mcpUnsupported = mcpCapability?.state === 'unsupported' || mcpCapability?.mode === 'none'
  const mcpCapabilityUnknown =
    !mcpCapability || mcpCapability.state === 'unknown' || mcpCapability.data == null
  const capabilityConfiguredCount = mcpCapability?.data?.configured.length ?? null
  const mcpPartial =
    mcpCapability?.state === 'degraded' ||
    (enabledMcpCount > 0 && mcpLive.length < enabledMcpCount) ||
    (capabilityConfiguredCount != null && capabilityConfiguredCount !== mcps.length)
  const mcpTrueZero =
    !mcpUnsupported &&
    !mcpCapabilityUnknown &&
    mcps.length === 0 &&
    mcpCapability?.data?.configured.length === 0

  let mcpState: EvidenceState = 'exact'
  let mcpTitle = `MCP runtime 已报告 ${mcpLive.length} 项状态`
  let mcpSummary = `${mcpConnected.length} connected · ${mcpDisabled.length} disabled`
  let mcpValue = mcpLive.length > 0 ? `${mcpConnected.length}/${mcpLive.length}` : String(mcps.length)
  let mcpAction = '无需处置。'
  let mcpAttention = false
  if (mcpFailed.length > 0) {
    mcpState = 'error'
    mcpTitle = `${mcpFailed.length} 个 MCP 连接失败`
    mcpSummary = mcpFailed.map((entry) => `${entry.name} failed`).join(' · ')
    mcpValue = `${mcpFailed.length}/${mcpLive.length}`
    mcpAction = '在 MCP 面板核验配置并重新连接。'
    mcpAttention = true
  } else if (mcpAuth.length > 0) {
    mcpState = 'warn'
    mcpTitle = `${mcpAuth.length} 个 MCP 需要认证`
    mcpSummary = mcpAuth.map((entry) => `${entry.name} ${entry.status}`).join(' · ')
    mcpValue = `${mcpAuth.length}/${mcpLive.length}`
    mcpAction = '在 MCP 面板完成 Provider 原生认证。'
    mcpAttention = true
  } else if (mcpPending.length > 0) {
    mcpState = 'partial'
    mcpTitle = `${mcpPending.length} 个 MCP 状态待收敛`
    mcpSummary = mcpPending.map((entry) => `${entry.name} pending`).join(' · ')
    mcpValue = `${mcpPending.length}/${mcpLive.length}`
    mcpAction = '等待 runtime 初始化完成，或重新探测。'
    mcpAttention = true
  } else if (mcpUnsupported) {
    mcpState = 'unsupported'
    mcpTitle = '当前 Provider 不暴露 MCP'
    mcpSummary = mcpCapability?.reason ?? 'Provider adapter 明确禁用或不支持 MCP。'
    mcpValue = '未支持'
  } else if (mcpCapabilityUnknown) {
    mcpState = 'unknown'
    mcpTitle = 'MCP 能力状态未知'
    mcpSummary = mcpCapability?.reason ?? 'MCP capability 尚未返回完整证据。'
    mcpValue = '—'
    mcpAction = '重新探测以获取 capability 与 runtime 状态。'
    mcpAttention = true
  } else if (mcpTrueZero) {
    mcpState = 'true-zero'
    mcpTitle = 'MCP 配置为真实 0'
    mcpSummary = 'Capability 查询成功，Provider 返回空配置。'
    mcpValue = '0'
  } else if (mcpPartial) {
    mcpState = 'partial'
    mcpTitle = '部分 MCP 缺少 runtime 状态'
    mcpSummary = `${mcps.length} 项配置 · ${mcpLive.length} 项 runtime 状态。`
    mcpValue = `${mcpLive.length}/${mcps.length}`
    mcpAction = '重新探测以补齐已启用配置的 runtime 状态。'
    mcpAttention = true
  } else if (mcps.length > 0 && enabledMcpCount === 0) {
    mcpTitle = 'MCP 配置均已禁用'
    mcpSummary = `${mcpDisabled.length} 项配置均为 disabled；不解释为连接失败。`
    mcpValue = `${mcpDisabled.length} disabled`
  }

  const mcpEvidence: DiagnosticEvidenceEvent[] = [
    mcpCapability
      ? {
          when: '能力快照',
          source: `${mcpCapability.providerId} capability`,
          finding: `${mcpCapability.state} · mode ${mcpCapability.mode}${mcpCapability.reason ? ` · ${mcpCapability.reason}` : ''}`,
          state:
            mcpUnsupported
              ? 'unsupported'
              : mcpCapability.state === 'ready'
                ? 'exact'
                : mcpCapability.state === 'degraded'
                  ? 'partial'
                  : 'unknown'
        }
      : { when: '能力快照', source: 'MCP capability', finding: '能力封套未返回', state: 'unknown' },
    ...mcps.map((entry) => ({
      when: '配置快照',
      source: entry.name,
      finding: `${entry.transport} · ${entry.scope} · ${entry.enabled ? 'enabled' : 'disabled'}`,
      state: 'exact' as const
    })),
    ...mcpLive.map((entry) => ({
      when: 'runtime 快照',
      source: entry.name,
      finding: `${entry.status}${entry.serverVersion ? ` · ${entry.serverVersion}` : ''}${
        entry.tools == null ? '' : ` · ${entry.tools} tools`
      }`,
      state: statusForMcp(entry.status)
    }))
  ]

  const mcpIssue: DiagnosticIssue = {
    id: 'mcp',
    state: mcpState,
    title: mcpTitle,
    summary: mcpSummary,
    value: mcpValue,
    action: mcpAction,
    attention: mcpAttention,
    evidence: mcpEvidence
  }

  const inputKnown = usageAvailable && usage.tin != null
  const outputKnown = usageAvailable && usage.tout != null
  const knownUsageTokens = (inputKnown ? usage.tin ?? 0 : 0) + (outputKnown ? usage.tout ?? 0 : 0)
  const tokenState: EvidenceState =
    !usageAvailable || (!inputKnown && !outputKnown)
      ? 'unknown'
      : usage?.status === 'partial' || !inputKnown || !outputKnown
        ? 'partial'
        : inputKnown && outputKnown
        ? knownUsageTokens === 0
          ? 'true-zero'
          : 'exact'
        : 'unknown'
  const tokenValue =
    tokenState === 'unknown'
      ? '—'
      : tokenState === 'partial'
        ? `≥ ${fmtTok(knownUsageTokens)}`
        : fmtTok(knownUsageTokens)
  const ledgerTurns = usageAvailable ? usage.turns : dbReady ? stats.totals.turns : null
  const ledgerValue =
    ledgerTurns == null ? '—' : usage?.status === 'partial' ? `≥ ${ledgerTurns}` : String(ledgerTurns)
  const ledgerPartial =
    !dbReady ||
    !usageAvailable ||
    usage?.status === 'partial' ||
    (usageReady && usage.invalidLines > 0) ||
    tokenState === 'partial' ||
    tokenState === 'unknown'
  const ledgerState: EvidenceState =
    !dbReady && !usageAvailable
      ? 'unknown'
      : ledgerPartial
        ? 'partial'
        : ledgerTurns === 0
          ? 'true-zero'
          : 'exact'
  const ledgerIssue: DiagnosticIssue = {
    id: 'ledger',
    state: ledgerState,
    title:
      ledgerState === 'unknown'
        ? 'SQLite 与 usage 均无可信结果'
        : ledgerState === 'partial'
          ? '账本证据仅部分可用'
          : ledgerState === 'true-zero'
            ? '账本轮次为真实 0'
            : '账本与用量查询已返回',
    summary: `SQLite native 健康 ${stats?.status ?? 'unknown'} · usage ${usage?.status ?? 'unknown'} · Token ${tokenValue}`,
    value: ledgerValue,
    action: ledgerPartial ? '检查 stats / usage IPC 状态；缺字段继续按未知或下界展示。' : '无需处置。',
    attention: ledgerState === 'unknown' || ledgerState === 'partial',
    evidence: [
      {
        when: 'SQLite IPC',
        source: '跨会话账本',
        finding: dbReady
          ? `${stats.totals.turns} turns · ${stats.topTools.length} tool types`
          : `stats ${stats?.status ?? 'unknown'}`,
        state: dbReady ? (stats.totals.turns === 0 ? 'true-zero' : 'exact') : 'unknown'
      },
      {
        when: 'usage IPC',
        source: '当前用量账本',
        finding: usageAvailable
          ? `${usage.turns} turns · ${usage.invalidLines} invalid lines · Token ${tokenValue}`
          : `usage ${usage?.status ?? 'unknown'}${usage?.error ? ` · ${usage.error}` : ''}`,
        state:
          !usageAvailable
            ? 'unknown'
            : usage.status === 'partial' || usage.invalidLines > 0 || tokenState === 'partial' || tokenState === 'unknown'
              ? 'partial'
              : usage.turns === 0
                ? 'true-zero'
                : 'exact'
      }
    ]
  }

  const archiveState: EvidenceState =
    projects.length === 0 ? 'unknown' : sessionCount === 0 ? 'true-zero' : 'exact'
  const archiveIssue: DiagnosticIssue = {
    id: 'archive',
    state: archiveState,
    title:
      projects.length === 0
        ? '项目索引状态未知'
        : sessionCount === 0
          ? '已索引项目中会话为真实 0'
          : `索引到 ${sessionCount} 个会话`,
    summary:
      projects.length === 0
        ? '空项目数组没有加载状态，不能解释为“真实 0”。'
        : `${projects.length} 个项目 · ${sessionCount} 个会话。`,
    value: projects.length === 0 ? '—' : String(sessionCount),
    action: projects.length === 0 ? '等待项目索引返回；如持续为空，重新探测。' : '无需处置。',
    attention: false,
    evidence:
      projects.length === 0
        ? [{ when: '当前快照', source: 'project index', finding: '项目数组为空且无加载状态', state: 'unknown' }]
        : projects.map((project) => ({
            when: '索引快照',
            source: project.name,
            finding: `${project.sessions.length} sessions · ${project.cwd}`,
            state: project.sessions.length === 0 ? 'true-zero' : 'exact'
          }))
  }

  const capabilityCoverageComplete = resultCount > 0 && explicitCapabilityResults.length === resultCount
  const capabilityCoverageMixed = explicitCapabilityResults.length > 0 && !capabilityCoverageComplete
  const runtimeState: EvidenceState =
    runtimeWarnings.length > 0 || capabilityCoverageMixed
      ? 'partial'
      : capabilityCoverageComplete
        ? 'true-zero'
        : unknownCapabilityResults.length > 0
          ? 'unknown'
          : unsupportedCapabilityResults.length > 0
            ? 'unsupported'
            : 'unknown'
  const runtimeIssue: DiagnosticIssue = {
    id: 'runtime-capability',
    state: runtimeState,
    title:
      runtimeWarnings.length > 0
        ? `${runtimeWarnings.length} 个 runtime capability 警告`
        : capabilityCoverageComplete
          ? 'Runtime capability 警告为真实 0'
          : capabilityCoverageMixed
            ? 'Runtime capability 仅部分覆盖'
            : unknownCapabilityResults.length > 0
              ? 'Runtime capability 证据未知'
              : unsupportedCapabilityResults.length > 0
                ? '当前 runtime 未支持 capabilityWarnings'
          : '尚无当前会话 runtime 结果',
    summary:
      runtimeWarnings.length > 0
        ? runtimeWarnings
            .map((warning) => `${warning.runtimeProvider} ${warning.name} ${warning.observed ?? warning.reason}`)
            .join(' · ')
        : capabilityCoverageComplete
          ? `${resultCount} 个 result 均显式上报空 capabilityWarnings 数组。`
          : capabilityCoverageMixed
            ? `${explicitCapabilityResults.length}/${resultCount} 个 result 显式上报；缺字段不按 0 解释。`
            : unknownCapabilityResults.length > 0
              ? `${unknownCapabilityResults.length} 个 result 缺少 capabilityWarnings 字段。`
              : unsupportedCapabilityResults.length > 0
                ? 'claude_sdk result 不暴露 capabilityWarnings 字段。'
                : '没有 result 事件，不能把警告数显示为 0。',
    value:
      runtimeWarnings.length > 0
        ? capabilityCoverageComplete
          ? String(runtimeWarnings.length)
          : `≥ ${runtimeWarnings.length}`
        : capabilityCoverageComplete
          ? '0'
          : capabilityCoverageMixed
            ? `${explicitCapabilityResults.length}/${resultCount}`
            : '—',
    action:
      runtimeWarnings.length > 0 || capabilityCoverageMixed || unknownCapabilityResults.length > 0
        ? '按 runtime 原始 result 核验 capabilityWarnings 字段。'
        : '无需处置。',
    attention: runtimeWarnings.length > 0 || capabilityCoverageMixed || unknownCapabilityResults.length > 0,
    evidence: [
      ...runtimeWarnings.map((warning) => ({
        when: warning.ts || 'result 事件',
        source: `${warning.runtimeProvider} · ${warning.name}`,
        finding: `${warning.observed ? `observed ${warning.observed} · ` : ''}${warning.reason}${
          warning.evidence ? ` · ${warning.evidence}` : ''
        }`,
        state: 'partial' as const
      })),
      ...(resultCount > 0
        ? resultItems.map((item) => {
            const raw = item.runtimeMetadata?.capabilityWarnings
            const explicit = Array.isArray(raw)
            const unsupported = !explicit && item.runtimeProvider === 'claude_sdk'
            return {
              when: item.ts || 'result 事件',
              source: item.runtimeProvider ?? item.providerId ?? 'runtime',
              finding: explicit
                ? `capabilityWarnings 显式数组 · ${raw.length} 项`
                : 'result 缺少 capabilityWarnings 字段',
              state: explicit ? (raw.length === 0 ? ('true-zero' as const) : ('partial' as const)) : unsupported ? ('unsupported' as const) : ('unknown' as const)
            }
          })
        : [{ when: '当前会话', source: 'result events', finding: '无 result 事件', state: 'unknown' as const }])
    ]
  }

  const dangerHasFindings = trendTotal > 0 || sessionDangers.length > 0
  const dangerCoverageState: EvidenceState =
    !dbReady || sampledDangerCoverage.length === 0
      ? 'unknown'
      : unsupportedDangerCoverage.length === 0
        ? 'exact'
        : classifiedDangerCoverage.length === 0
          ? 'unsupported'
          : 'partial'
  const dangerState: EvidenceState =
    dangerCoverageState === 'exact'
      ? dangerHasFindings
        ? 'warn'
        : 'true-zero'
      : dangerCoverageState === 'unsupported'
        ? dangerHasFindings
          ? 'partial'
          : 'unsupported'
        : dangerCoverageState === 'partial' || dangerHasFindings
          ? 'partial'
          : 'unknown'
  const dangerCoverageSummary =
    sampledDangerCoverage.length === 0
      ? 'providerCoverage 没有带样本的记录'
      : `${classifiedDangerCoverage.map((entry) => entry.providerId).join(' / ') || '无'} 已分类 · ${
          unsupportedDangerCoverage.map((entry) => entry.providerId).join(' / ') || '无'
        } 未支持`
  const dangerIssue: DiagnosticIssue = {
    id: 'danger-audit',
    state: dangerState,
    title:
      dangerState === 'true-zero'
        ? '完整分类覆盖内危险审计为真实 0'
        : dangerState === 'unsupported'
          ? '当前样本的危险分类未支持'
        : dangerState === 'unknown'
          ? '跨会话危险审计未知'
          : dangerState === 'partial' && !dangerHasFindings
            ? '危险审计仅部分覆盖'
            : `危险审计：本会话 ${sessionDangers.length} · 跨会话 ${dbReady ? trendTotal : '—'}`,
    summary: `${dangerCoverageSummary} · ${sessionDangers[0]?.danger?.reason ?? dangerTrend[0]?.reason ?? '当前没有已知危险标记'} · 仅观测，不拦截。`,
    value:
      dangerState === 'true-zero'
        ? '0'
        : dangerState === 'unsupported' || dangerState === 'unknown' || !dangerHasFindings
          ? '—'
          : dbReady
            ? `跨 ${trendTotal} · 本 ${sessionDangers.length}`
            : `本 ${sessionDangers.length}`,
    action:
      dangerState === 'warn' || dangerState === 'partial'
        ? '检查原始 tool span；标记只用于审计，不代表执行被拦截。'
        : '无需处置。',
    attention: dangerState === 'warn' || dangerState === 'partial' || dangerState === 'unknown',
    evidence: [
      ...sessionDangers.map((item) => ({
        when: item.ts || '当前会话',
        source: item.tool ?? item.name ?? item.stage,
        finding: `${item.danger?.reason ?? '危险原因未上报'} · 观测放行`,
        state: item.danger?.level === 'danger' ? ('error' as const) : ('warn' as const)
      })),
      ...(dbReady
        ? dangerTrend.map((entry) => ({
            when: 'SQLite 聚合',
            source: entry.level === 'danger' ? '高危模式' : '可疑模式',
            finding: `${entry.reason} ×${entry.n}`,
            state: entry.level === 'danger' ? ('error' as const) : ('warn' as const)
          }))
        : [{ when: 'SQLite 聚合', source: 'danger trend', finding: '跨会话统计不可用', state: 'unknown' as const }]),
      ...sampledDangerCoverage.map((entry) => ({
        when: '覆盖矩阵',
        source: entry.providerId,
        finding: `${entry.turns} turns · danger ${entry.dangerCoverage}`,
        state: entry.dangerCoverage === 'classified' ? ('exact' as const) : ('unsupported' as const)
      })),
      ...(dangerState === 'true-zero'
        ? [{ when: 'SQLite 聚合', source: 'danger trend', finding: '完整分类覆盖内查询成功 · 0 条标记', state: 'true-zero' as const }]
        : [])
    ]
  }

  const issues = [
    agentIssue,
    diagnosticsIssue,
    mcpIssue,
    ledgerIssue,
    archiveIssue,
    runtimeIssue,
    dangerIssue
  ].sort((left, right) => {
    if (left.attention !== right.attention) return left.attention ? -1 : 1
    return STATE_RANK[left.state] - STATE_RANK[right.state]
  })
  const selected = issues.find((issue) => issue.id === selectedId) ?? issues[0]
  const attentionCount = issues.filter((issue) => issue.attention).length
  const clearCount = issues.filter((issue) => issue.state === 'exact' || issue.state === 'true-zero').length
  const partialCount = issues.filter((issue) => issue.state === 'partial').length
  const unsupportedCount = issues.filter((issue) => issue.state === 'unsupported').length
  const unknownCount = issues.filter((issue) => issue.state === 'unknown').length
  const verdictState: EvidenceState =
    agents.length === 0 ? 'error' : attentionCount > 0 ? 'warn' : unknownCount + unsupportedCount > 0 ? 'unknown' : 'exact'
  const vstate = verdictState === 'error' ? 'bad' : verdictState === 'warn' || verdictState === 'unknown' ? 'warn' : 'ok'
  const verdictTitle =
    agents.length === 0
      ? '未检测到 Provider'
      : attentionCount > 0
        ? `运行 · ${attentionCount} 项需关注`
        : unknownCount + unsupportedCount > 0
          ? '运行 · 证据范围有限'
          : '检查通过'
  const verdictDetail =
    issues.find((issue) => issue.attention)?.summary ??
    (unknownCount + unsupportedCount > 0 ? '未知与未支持保持独立，不按 0 解释。' : '当前只读快照未见需要处置的诊断项。')

  return (
    <main className="d-pane diagnostics-evidence-page">
      <header className="d-hero de-view-header">
        <div>
          <span className="surface-kicker">02 · DIAGNOSTICS</span>
          <h2>先说结论，再交付证据</h2>
          <p>按解释风险排序；盲区、未支持与真实故障分开表达。</p>
        </div>
        <button type="button" className="btn de-reprobe" onClick={onReprobe}>
          <Icon name="refresh" />
          重新探测
        </button>
      </header>

      <div className="de-shell">
        <section className="de-verdict-band" data-tone={verdictState}>
          <div className="de-verdict-main">
            <span>系统状态</span>
            <div className={`judgement ${vstate}`}>
              <StatusMark state={verdictState} label={verdictTitle} />
            </div>
            <b>{attentionCount}</b>
            <p>{attentionCount > 0 ? '项会影响当前解释' : '项需要处置'}</p>
            <small>{verdictDetail}</small>
          </div>
          {[
            { label: 'CHECKS', value: issues.length, state: 'exact' as const },
            { label: 'CLEAR', value: clearCount, state: clearCount === 0 ? ('true-zero' as const) : ('exact' as const) },
            { label: 'PARTIAL', value: partialCount, state: partialCount === 0 ? ('true-zero' as const) : ('partial' as const) },
            {
              label: 'UNSUPPORTED',
              value: unsupportedCount,
              state: unsupportedCount === 0 ? ('true-zero' as const) : ('unsupported' as const)
            }
          ].map((metric) => (
            <div className="de-verdict-metric" key={metric.label}>
              <span>{metric.label}</span>
              <span
                className={`de-known de-known-${metric.state}`}
                data-state={metric.state}
                title={STATE_LABEL[metric.state]}
              >
                {metric.value}
              </span>
            </div>
          ))}
        </section>

        <div className="de-workspace">
          <section className="de-issue-channel" aria-labelledby="diagnostic-issue-title">
            <div className="de-section-title">
              <span>01</span>
              <h3 id="diagnostic-issue-title">优先检查</h3>
              <i />
              <small>按解释风险排序</small>
            </div>
            <div className="de-issue-list">
              {issues.map((issue) => (
                <button
                  type="button"
                  key={issue.id}
                  className={`de-issue-row de-severity-${issue.state} ${selected.id === issue.id ? 'active' : ''}`}
                  aria-pressed={selected.id === issue.id}
                  aria-label={`${issue.title}。${issue.summary}。${issue.evidence
                    .map((event) => `${event.source}：${event.finding}`)
                    .join('；')}`}
                  onClick={() => setSelectedId(issue.id)}
                >
                  <StatusMark state={issue.state} />
                  <span className="de-issue-copy">
                    <b>{issue.title}</b>
                    <small>{issue.summary}</small>
                  </span>
                  <KnownValue value={issue.value} state={issue.state} />
                  <Icon name="chevronRight" />
                </button>
              ))}
            </div>
          </section>

          <aside className="de-inspector" aria-live="polite" aria-label="诊断证据检查器">
            <header>
              <span>EVIDENCE CHANNEL</span>
              <StatusMark state={selected.state} />
            </header>
            <h3>{selected.title}</h3>
            <p>{selected.summary}</p>
            <div className="de-timeline">
              {selected.evidence.map((event, index) => (
                <div className="de-evidence-event" key={`${selected.id}-${index}-${event.source}`}>
                  <time>{event.when}</time>
                  <i />
                  <span>
                    <b>{event.source}</b>
                    <small>{event.finding}</small>
                  </span>
                  <StatusMark state={event.state} />
                </div>
              ))}
            </div>
            <div className="de-next-action">
              <span>NEXT ACTION</span>
              <p>{selected.action}</p>
            </div>
            <div className="de-source-line">
              <span>SOURCE</span>
              <i />
              <b>当前 props · Provider capability · trace archive · SQLite IPC</b>
            </div>
          </aside>
        </div>

        <footer className="de-footer">
          <div aria-label="诊断状态图例">
            <StatusMark state="exact" label="完整" />
            <StatusMark state="partial" label="部分" />
            <StatusMark state="unknown" label="未知" />
            <StatusMark state="unsupported" label="未支持" />
            <StatusMark state="true-zero" label="真实 0" />
          </div>
          <span>诊断只报告证据，不自动修复或拦截；危险操作标记全部审计放行，未拦截。</span>
        </footer>
      </div>
    </main>
  )
}
