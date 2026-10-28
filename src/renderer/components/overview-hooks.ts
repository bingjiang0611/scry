// 会话级 Hook 证据的纯聚合：把生命周期事件收敛成可检查的脚本、实例与状态文案。
import type { HookConfiguredCommand, TraceEvent } from '@shared/trace'
import { basename, hookCancellationDetail, hookCommandLabel } from '../format'
import type { HookInstanceRow, HookScriptRow } from '../format'
import { formatTurnDuration } from './overview-turn-calls'

export function hookTone(h: { errors: number; responses: number; cancelled: number }): 'ok' | 'warn' | 'bad' {
  if (h.errors > 0) return 'bad'
  if (h.cancelled > 0) return 'warn'
  if (h.responses > 0) return 'ok'
  return 'warn'
}

function hookStatusText(h: { errors: number; responses: number; pending: number; cancelled: number; outcome?: string }): string {
  if (h.errors > 0) return 'error'
  if (h.cancelled > 0) return h.cancelled < h.responses ? '部分取消' : '已取消'
  if (h.responses > 0) return h.outcome ?? 'success'
  if (h.pending > 0) return 'started'
  return 'observed'
}

export function hookBadgeText(h: {
  errors: number
  responses: number
  pending: number
  logicalRuns: number
  cancelled: number
  unsuccessful: TraceEvent[]
  outcome?: string
  exitCode?: number
  lastError?: TraceEvent
  lastCancelled?: TraceEvent
}): string {
  const cancellation = hookCancellationDetail(h.lastCancelled)
  const failed = Math.max(h.errors, h.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length)
  const cancellationLabel =
    cancellation?.kind === 'timeout'
      ? '超时'
      : cancellation?.kind === 'suspected-timeout'
        ? '疑似超时'
        : '取消'
  const base =
    failed > 0
      ? `失败 ${failed}`
      : h.cancelled > 0
        ? `${h.cancelled < h.responses ? '取消' : cancellationLabel} ${h.cancelled}`
        : h.pending > 0
          ? `运行中 ${h.pending}`
          : h.responses > 0
            ? `成功 ${h.responses}`
            : hookStatusText(h)
  const errorInput = h.lastError?.input as Record<string, unknown> | undefined
  const errorExit =
    h.errors > 0 && h.lastError
      ? h.lastError.hookExitCode ?? (typeof errorInput?.exitCode === 'number' ? errorInput.exitCode : undefined)
      : undefined
  const code = h.errors > 0 ? errorExit ?? h.exitCode : undefined
  const exit = code != null ? ` · ${code}` : ''
  return `${base}${exit}`
}

export function hookDetailText(h: HookScriptRow): string {
  const failed = Math.max(h.errors, h.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length)
  const succeeded = Math.max(0, h.responses - h.cancelled - failed)
  const parts: string[] = []
  if (succeeded > 0) parts.push(`成功 ${succeeded}`)
  if (h.cancelled > 0) parts.push(`取消 ${h.cancelled}`)
  if (failed > 0) parts.push(`失败 ${failed}`)
  if (h.pending > 0) parts.push(`未结束 ${h.pending}`)
  if (h.progress > 0) parts.push(`进度通知 ${h.progress}`)
  return parts.join(' · ')
}

export function hookCancellationTitle(h: HookScriptRow): string | undefined {
  const detail = hookCancellationDetail(h.lastCancelled)
  if (!detail) return undefined
  const label = detail.kind === 'timeout' ? '超时终止' : detail.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
  const duration = formatTurnDuration(detail.durationMs)
  const timeout = formatTurnDuration(detail.timeoutMs)
  const limit = timeout
    ? ` / ${detail.timeoutSource === 'current-config' ? '当前配置上限' : '上限'} ${timeout}`
    : ''
  return `${label}${duration ? `：${duration}${limit}` : ''}；Hook 未正常完成，不代表对应工具调用也被取消。`
}

export function hookFailureText(h: HookScriptRow): string | undefined {
  if (h.errors <= 0) return undefined
  return h.failureSummary ?? '最近失败事件未提供 stdout、stderr 或 content；只能看到 hook outcome / exit code。'
}

export function hookConfigScopeLabel(source: HookConfiguredCommand['source']): string {
  return source === 'user' ? '用户' : source === 'project' ? '项目' : source === 'local' ? '本地' : '插件'
}

export function uniqueConfiguredCommands(instances: HookInstanceRow[]): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return instances
    .flatMap((instance) => instance.configuredCommands)
    .filter((candidate) => {
      const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function instanceConfiguredCommands(instance: HookInstanceRow): HookConfiguredCommand[] {
  if (instance.command) return []
  if (instance.sourcePath) {
    const samePath = instance.configuredCommands.filter((candidate) => candidate.sourcePath === instance.sourcePath)
    if (samePath.length > 0) return samePath
  }
  if (instance.source) {
    const sameSource = instance.configuredCommands.filter((candidate) => candidate.source === instance.source)
    if (sameSource.length > 0) return sameSource
  }
  return instance.configuredCommands
}

export function hookInstanceLabel(instance: HookInstanceRow): string {
  if (instance.command) return hookCommandLabel(instance.command) ?? 'command'
  const candidates = instanceConfiguredCommands(instance)
  if (candidates.length === 1) return hookCommandLabel(candidates[0].command) ?? 'command'
  return '命令未逐实例上报'
}

export function hookInstanceTone(instance: HookInstanceRow): 'ok' | 'warn' | 'bad' {
  if (instance.isError || instance.outcome === 'error' || instance.outcome === 'failure') return 'bad'
  if (instance.outcome === 'cancelled') return 'warn'
  if (instance.outcome === 'success') return 'ok'
  return 'warn'
}

export function hookInstanceStatus(instance: HookInstanceRow): string {
  if (instance.isError || instance.outcome === 'error' || instance.outcome === 'failure') return '失败'
  if (instance.outcome === 'cancelled') return '取消'
  if (instance.outcome === 'success') return '成功'
  return '运行中'
}

export interface HookInstanceDisplayGroup {
  key: string
  label: string
  status: string
  tone: 'ok' | 'warn' | 'bad'
  count: number
  averageDurationMs?: number
  timedCount: number
  sources: string[]
  last: TraceEvent
}

export function hookInstanceSourceLabel(instance: HookInstanceRow): string {
  const sourcePath = instance.sourcePath ? basename(instance.sourcePath) : undefined
  return `${instance.source ? hookConfigScopeLabel(instance.source) : '来源未上报'}${sourcePath ? ` · ${sourcePath}` : ''}`
}

export function groupHookInstances(instances: HookInstanceRow[]): HookInstanceDisplayGroup[] {
  const groups = new Map<
    string,
    Omit<HookInstanceDisplayGroup, 'averageDurationMs' | 'sources'> & {
      durationTotalMs: number
      sources: Set<string>
    }
  >()

  for (const instance of instances) {
    const label = hookInstanceLabel(instance)
    const status = hookInstanceStatus(instance)
    const key = `${label}\0${status}`
    const group = groups.get(key) ?? {
      key,
      label,
      status,
      tone: hookInstanceTone(instance),
      count: 0,
      timedCount: 0,
      durationTotalMs: 0,
      sources: new Set<string>(),
      last: instance.last
    }
    group.count++
    group.last = instance.last
    group.sources.add(hookInstanceSourceLabel(instance))
    if (instance.durationMs != null && Number.isFinite(instance.durationMs) && instance.durationMs >= 0) {
      group.durationTotalMs += instance.durationMs
      group.timedCount++
    }
    groups.set(key, group)
  }

  return [...groups.values()].map(({ durationTotalMs, sources, ...group }) => ({
    ...group,
    averageDurationMs: group.timedCount > 0 ? durationTotalMs / group.timedCount : undefined,
    sources: [...sources]
  }))
}

export function hookDispatchLabel(command: string): string {
  return command.includes('global-hook-bridge.py') ? '桥接' : '直连'
}

export interface LogicalHookRow {
  name: string
  deliveries: string[]
}

export function logicalHookRows(commands: HookConfiguredCommand[], runtimeCommand?: string): LogicalHookRow[] {
  const rows = new Map<string, Set<string>>()
  const add = (name: string, delivery: string): void => {
    const deliveries = rows.get(name) ?? new Set<string>()
    deliveries.add(delivery)
    rows.set(name, deliveries)
  }
  if (runtimeCommand) add(hookCommandLabel(runtimeCommand) ?? 'command', '运行时')
  for (const candidate of commands) {
    add(
      hookCommandLabel(candidate.command) ?? 'command',
      `${hookConfigScopeLabel(candidate.source)}${candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}${candidate.source === 'plugin' ? '' : ` ${hookDispatchLabel(candidate.command)}`}`
    )
  }
  return [...rows.entries()]
    .map(([name, deliveries]) => ({ name, deliveries: [...deliveries] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
