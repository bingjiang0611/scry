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
  id?: string
  exitCode?: number
  error?: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
}

/** 错误正文是有界引用，不是解析结果：截断只影响长度，不改变结论。 */
const HOOK_ERROR_MAX = 500
function boundedError(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text.length <= HOOK_ERROR_MAX ? text : `${text.slice(0, HOOK_ERROR_MAX - 1)}…`
}

/**
 * 失败的运行不合并：每次失败都保留自己的关联 ID、命令、原始退出码、耗时与错误正文。
 * 合并后只剩 runs/failed 计数，就无法再定位是哪次工具调用的 hook 失败、退出了多少。
 */
function failedHookRun(run: HookRun): TurnHookCall {
  return {
    ...(run.order != null ? { order: run.order } : {}),
    lifecycleEvents: run.lifecycleEvents,
    runs: 1,
    event: run.event,
    ...(run.name ? { name: run.name } : {}),
    ...(run.command ? { command: run.command } : {}),
    ...(run.id ? { id: run.id } : {}),
    ...(run.exitCode != null ? { exitCode: run.exitCode } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
    status: run.status
  }
}

// 相同 event+name+command 的多次成功运行折叠成一条：保留 runs 计数，丢弃逐次的 id/exitCode，
// 大幅压缩重复命令串（同一 hook 脚本在每个工具调用上重复触发）。失败运行不走这里。
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
    const orders = group.map((run) => run.order).filter((value): value is number => value != null)
    const startedAt = group.map((run) => run.startedAt).sort()[0]
    const completedAts = group.map((run) => run.completedAt).filter((value): value is string => !!value).sort()
    const hasDuration = group.some((run) => run.durationMs != null)
    const durationMs = group.reduce((sum, run) => sum + (run.durationMs ?? 0), 0)
    const status: TurnCallStatus =
      group.some((run) => run.status === 'unknown') ? 'unknown' : first.status
    return {
      ...(orders.length > 0 ? { order: Math.min(...orders) } : {}),
      lifecycleEvents: group.reduce((sum, run) => sum + run.lifecycleEvents, 0),
      runs: group.length,
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
    // 一个工具调用会长出 PreToolUse / PostToolUse 等不同 hook 运行，它们共享 tool-use 关联 ID 但不是同一次运行。
    const key = event.hookId
      ? `hook:${event.hookId}\u0000${event.hookEvent ?? ''}`
      : `event:${event.id}`
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
    const status = hookStatus(terminal)
    return {
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: ordered.length,
      event: last.hookEvent ?? first.hookEvent ?? last.name ?? first.name ?? 'Hook',
      ...(last.hookName ?? first.hookName ? { name: last.hookName ?? first.hookName } : {}),
      ...(last.hookCommand ?? first.hookCommand ? { command: last.hookCommand ?? first.hookCommand } : {}),
      ...(terminal.hookId ?? first.hookId ? { id: terminal.hookId ?? first.hookId } : {}),
      ...(terminal.hookExitCode != null ? { exitCode: terminal.hookExitCode } : {}),
      ...(status === 'failed' ? { error: boundedError(terminal.output ?? terminal.text) } : {}),
      startedAt: started.ts,
      ...(terminal !== started ? { completedAt: terminal.ts } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      status
    }
  })
  const merged = [
    ...collapseHookRuns(runs.filter((run) => run.status !== 'failed')),
    ...runs.filter((run) => run.status === 'failed').map(failedHookRun)
  ].sort((left, right) =>
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
    (left.startedAt ?? '').localeCompare(right.startedAt ?? '') ||
    left.event.localeCompare(right.event)
  )
  return [...merged, ...aggregateHookDeliveries(events, eventOrder)]
}
