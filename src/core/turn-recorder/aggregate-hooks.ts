import { HOOK_DELIVERY_STAGE, type TraceEvent } from '../../shared/trace.js'
import { type TurnCallStatus, type TurnHookCall } from '../../shared/turn-record.js'

function hookStatus(event: TraceEvent): TurnCallStatus {
  if (event.hookOutcome === 'cancelled') return 'cancelled'
  if (event.isError || event.hookOutcome === 'error' || (event.hookExitCode != null && event.hookExitCode !== 0)) return 'failed'
  if (event.hookOutcome === 'success' || event.hookOutcome === 'completed') return 'success'
  if (event.hookOutcome === 'started') return 'started'
  return 'unknown'
}

export function isRecorderHook(event: TraceEvent): boolean {
  if (event.hookName === 'turn-recorder-v1') return true
  if (/scry-recorder\.sh|turn-recorder-v1/.test(`${event.hookName ?? ''}\n${event.hookCommand ?? ''}`)) return true
  const input = event.input as Record<string, unknown> | undefined
  return input?.handlerId === 'turn-recorder-v1' || input?.SCRY_HANDLER_ID === 'turn-recorder-v1'
}

/**
 * 只能证明「hook 事件触发过」的投递事件（`HOOK_DELIVERY_STAGE`）按事件名 + 子 agent 归属归并成一条，
 * 只落首次投递时刻与投递次数：脚本身份、耗时、退出码都没观测到，不得补 name / command / completedAt / durationMs / success。
 */
function aggregateHookDeliveries(events: TraceEvent[], eventOrder: Map<TraceEvent, number>): TurnHookCall[] {
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events) {
    if (event.kind !== 'hook' || event.stage !== HOOK_DELIVERY_STAGE) continue
    const key = `${event.hookEvent ?? event.name ?? 'Hook'}\u0000${event.agentId ?? ''}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const first = [...group].sort((left, right) => left.ts.localeCompare(right.ts))[0]
    return {
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: group.length,
      runs: group.length,
      event: first.hookEvent ?? first.name ?? 'Hook',
      startedAt: first.ts,
      status: 'unknown' as const
    }
  })
}

interface HookRun {
  order?: number
  lifecycleEvents: number
  event: string
  name?: string
  command?: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
}

// 相同 event+name+command 的多次运行折叠成一条：保留 runs/failed 计数，丢弃逐次的 id/exitCode，
// 大幅压缩重复命令串（同一 hook 脚本在每个工具调用上重复触发）。
function collapseHookRuns(runs: HookRun[]): TurnHookCall[] {
  const groups = new Map<string, HookRun[]>()
  for (const run of runs) {
    const key = `${run.event}\u0000${run.name ?? ''}\u0000${run.command ?? ''}`
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const first = group[0]
    const failed = group.filter((run) => run.status === 'failed').length
    const orders = group.map((run) => run.order).filter((value): value is number => value != null)
    const startedAt = group.map((run) => run.startedAt).sort()[0]
    const completedAts = group.map((run) => run.completedAt).filter((value): value is string => !!value).sort()
    const hasDuration = group.some((run) => run.durationMs != null)
    const durationMs = group.reduce((sum, run) => sum + (run.durationMs ?? 0), 0)
    const status: TurnCallStatus =
      failed > 0 ? 'failed' : group.some((run) => run.status === 'unknown') ? 'unknown' : first.status
    return {
      ...(orders.length > 0 ? { order: Math.min(...orders) } : {}),
      lifecycleEvents: group.reduce((sum, run) => sum + run.lifecycleEvents, 0),
      runs: group.length,
      ...(failed > 0 ? { failed } : {}),
      event: first.event,
      ...(first.name ? { name: first.name } : {}),
      ...(first.command ? { command: first.command } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAts.length > 0 ? { completedAt: completedAts[completedAts.length - 1] } : {}),
      ...(hasDuration ? { durationMs } : {}),
      status
    }
  })
}

export function aggregateHooks(events: TraceEvent[], eventOrder: Map<TraceEvent, number>): TurnHookCall[] {
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events) {
    if (event.kind !== 'hook' || event.stage === HOOK_DELIVERY_STAGE || isRecorderHook(event)) continue
    const key = event.hookId ? `hook:${event.hookId}` : `event:${event.id}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const runs: HookRun[] = [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.ts.localeCompare(right.ts))
    const first = ordered[0]
    const last = ordered.at(-1) ?? first
    const terminal = [...ordered].reverse().find((event) => !['started', 'progress'].includes(event.hookOutcome ?? '')) ?? last
    const started = ordered.find((event) => event.hookOutcome === 'started') ?? first
    const startedMs = Date.parse(started.ts)
    const completedMs = Date.parse(terminal.ts)
    const durationMs = terminal.durationMs ?? (
      Number.isFinite(startedMs) && Number.isFinite(completedMs) && terminal !== started
        ? Math.max(0, completedMs - startedMs)
        : undefined
    )
    return {
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: ordered.length,
      event: last.hookEvent ?? first.hookEvent ?? last.name ?? first.name ?? 'Hook',
      ...(last.hookName ?? first.hookName ? { name: last.hookName ?? first.hookName } : {}),
      ...(last.hookCommand ?? first.hookCommand ? { command: last.hookCommand ?? first.hookCommand } : {}),
      startedAt: started.ts,
      ...(terminal !== started ? { completedAt: terminal.ts } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      status: hookStatus(terminal)
    }
  })
  return [...collapseHookRuns(runs), ...aggregateHookDeliveries(events, eventOrder)]
}
