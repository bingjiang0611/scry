// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。










import type { HookConfiguredCommand, TraceEvent } from '@shared/trace'







import type { HookGroup, HookScriptRow, HookSummary } from '../format'




interface TurnHookTriggerRow {
  trigger: string
  toolCalls: number
  displayedRuns: number
  exactConfiguredMapping: boolean
}

interface TurnHookScript extends HookScriptRow {
  configuredCommands: HookConfiguredCommand[]
  displayedRuns: number
  triggerRows: TurnHookTriggerRow[]
  exactConfiguredMapping: boolean
}

export interface TurnHookPhase {
  event: string
  logicalRuns: number
  responses: number
  pending: number
  errors: number
  cancelled: number
  triggerRuns: number | null
  scripts: TurnHookScript[]
}

interface HookPhaseTiming {
  durationMs: number
  timedInstances: number
  totalInstances: number
}

export function latestHookEvent(a: TraceEvent | undefined, b: TraceEvent | undefined): TraceEvent | undefined {
  if (!a) return b
  if (!b) return a
  const aTime = Date.parse(a.ts)
  const bTime = Date.parse(b.ts)
  if (!Number.isFinite(aTime)) return b
  if (!Number.isFinite(bTime)) return a
  return bTime >= aTime ? b : a
}

export function uniqueHookCommands(commands: HookConfiguredCommand[]): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return commands.filter((candidate) => {
    const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}\0${candidate.matcher ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function configuredCommandsForScript(script: HookScriptRow): HookConfiguredCommand[] {
  if (script.command) return []
  return uniqueHookCommands([
    ...script.instances.flatMap((instance) => instance.configuredCommands),
    ...(script.last?.hookConfiguredCommands ?? [])
  ])
}

export function hookTriggerRow(group: HookGroup, script: HookScriptRow, configuredCommands: HookConfiguredCommand[]): TurnHookTriggerRow {
  const exactConfiguredMapping =
    !script.command &&
    script.pending === 0 &&
    group.toolCalls > 0 &&
    configuredCommands.length > 0 &&
    group.toolCalls * configuredCommands.length === script.logicalRuns
  return {
    trigger: group.trigger,
    toolCalls: group.toolCalls,
    displayedRuns: exactConfiguredMapping ? group.toolCalls : script.logicalRuns,
    exactConfiguredMapping
  }
}

export function aggregateTurnHookPhases(summary: HookSummary): TurnHookPhase[] {
  const phases = new Map<string, TurnHookPhase & { scriptsByHandler: Map<string, TurnHookScript> }>()
  for (const group of summary.groups) {
    let phase = phases.get(group.event)
    if (!phase) {
      phase = {
        event: group.event,
        logicalRuns: 0,
        responses: 0,
        pending: 0,
        errors: 0,
        cancelled: 0,
        triggerRuns: null,
        scripts: [],
        scriptsByHandler: new Map()
      }
      phases.set(group.event, phase)
    }
    phase.logicalRuns += group.logicalRuns
    phase.responses += group.responses
    phase.pending += group.pending
    phase.errors += group.errors
    phase.cancelled += group.cancelled
    if (group.triggerRuns != null) phase.triggerRuns = (phase.triggerRuns ?? 0) + group.triggerRuns

    for (const script of group.scripts) {
      const configuredCommands = configuredCommandsForScript(script)
      const triggerRow = hookTriggerRow(group, script, configuredCommands)
      const handlerKey = script.command ? `command:${script.command}` : `unmapped:${script.key}`
      const existing = phase.scriptsByHandler.get(handlerKey)
      if (!existing) {
        phase.scriptsByHandler.set(handlerKey, {
          ...script,
          key: `${group.event}\0${handlerKey}`,
          configuredCommands,
          displayedRuns: triggerRow.displayedRuns,
          triggerRows: [triggerRow],
          exactConfiguredMapping: triggerRow.exactConfiguredMapping
        })
        continue
      }

      const last = latestHookEvent(existing.last, script.last)
      const lastError = latestHookEvent(existing.lastError, script.lastError)
      const lastCancelled = latestHookEvent(existing.lastCancelled, script.lastCancelled)
      phase.scriptsByHandler.set(handlerKey, {
        ...existing,
        rawEvents: existing.rawEvents + script.rawEvents,
        logicalRuns: existing.logicalRuns + script.logicalRuns,
        responses: existing.responses + script.responses,
        pending: existing.pending + script.pending,
        started: existing.started + script.started,
        progress: existing.progress + script.progress,
        errors: existing.errors + script.errors,
        cancelled: existing.cancelled + script.cancelled,
        outcome: last?.hookOutcome ?? (last === script.last ? script.outcome : existing.outcome),
        exitCode: last?.hookExitCode ?? (last === script.last ? script.exitCode : existing.exitCode),
        last,
        lastError,
        lastCancelled,
        unsuccessful: [...existing.unsuccessful, ...script.unsuccessful],
        failureSummary: lastError === script.lastError ? script.failureSummary : existing.failureSummary,
        instances: [...existing.instances, ...script.instances],
        configuredCommands: uniqueHookCommands([...existing.configuredCommands, ...configuredCommands]),
        displayedRuns: existing.displayedRuns + triggerRow.displayedRuns,
        triggerRows: [...existing.triggerRows, triggerRow],
        exactConfiguredMapping: existing.exactConfiguredMapping && triggerRow.exactConfiguredMapping
      })
    }
  }

  return [...phases.values()].map(({ scriptsByHandler, ...phase }) => ({
    ...phase,
    scripts: [...scriptsByHandler.values()].sort(
      (a, b) => b.displayedRuns - a.displayedRuns || a.label.localeCompare(b.label)
    )
  }))
}

export function formatHookPhaseDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const seconds = Math.round(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function hookPhaseTiming(phase: TurnHookPhase): HookPhaseTiming | undefined {
  const instances = new Map<string, HookScriptRow['instances'][number]>()
  for (const instance of phase.scripts.flatMap((script) => script.instances)) {
    const previous = instances.get(instance.key)
    if (!previous || previous.durationMs == null && instance.durationMs != null) instances.set(instance.key, instance)
  }
  const intervals = [...instances.values()].flatMap((instance): Array<[number, number]> => {
    let end = instance.completedAtMs
    if (end == null && instance.last.stage === 'hook_response') {
      const timestamp = Date.parse(instance.last.ts)
      if (Number.isFinite(timestamp)) end = timestamp
    }
    let start = instance.startedAtMs
    if (end != null && instance.durationMs != null && instance.durationSource === 'provider') {
      start = end - instance.durationMs
    }
    return start != null && end != null && end >= start ? [[start, end]] : []
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (intervals.length === 0) return undefined

  let durationMs = 0
  let [start, end] = intervals[0]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd)
    } else {
      durationMs += end - start
      start = nextStart
      end = nextEnd
    }
  }
  return { durationMs: durationMs + end - start, timedInstances: intervals.length, totalInstances: instances.size }
}
