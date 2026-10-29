// Hook 汇总：按生命周期把 hook 事件归到 事件×触发点×命令，并区分逻辑运行/响应/挂起/失败。
import type { HookConfiguredCommand, TraceEvent } from '@shared/trace'
import { hookCommandFromEvent, hookCommandLabel } from './format-hook-command'

export interface HookScriptRow {
  key: string
  event: string
  trigger: string
  label: string
  command?: string
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  started: number
  progress: number
  errors: number
  cancelled: number
  outcome?: string
  exitCode?: number
  last?: TraceEvent
  lastError?: TraceEvent
  lastCancelled?: TraceEvent
  unsuccessful: TraceEvent[]
  failureSummary?: string
  instances: HookInstanceRow[]
}

export interface HookInstanceRow {
  key: string
  hookId?: string
  command?: string
  source?: HookConfiguredCommand['source']
  sourcePath?: string
  configuredCommands: HookConfiguredCommand[]
  outcome?: string
  durationMs?: number
  durationSource?: 'provider' | 'observed'
  startedAtMs?: number
  completedAtMs?: number
  isError: boolean
  last: TraceEvent
}

export interface HookGroup {
  key: string
  event: string
  trigger: string
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  errors: number
  cancelled: number
  toolCalls: number
  triggerRuns: number | null
  last?: TraceEvent
  scripts: HookScriptRow[]
}

export interface HookSummary {
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  groups: HookGroup[]
}

const HOOK_LIFECYCLE = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'TeammateIdle',
  'TaskCompleted',
  'SessionEnd'
] as const

const HOOK_LIFECYCLE_RANK = new Map<string, number>(
  HOOK_LIFECYCLE.map((event, index) => [event, index])
)

function hookLifecycleRank(event: string): number {
  const normalized = event.split(':', 1)[0]
  if (normalized === 'tool.execute.before') return HOOK_LIFECYCLE_RANK.get('PreToolUse')!
  if (normalized === 'tool.execute.after') return HOOK_LIFECYCLE_RANK.get('PostToolUse')!
  if (normalized === 'session.start') return HOOK_LIFECYCLE_RANK.get('SessionStart')!
  if (normalized === 'session.stop' || normalized === 'session.idle') return HOOK_LIFECYCLE_RANK.get('Stop')!
  return HOOK_LIFECYCLE_RANK.get(normalized) ?? HOOK_LIFECYCLE.length
}

function hookGroupFirstTimestamp(group: HookGroup): number {
  let first = Number.POSITIVE_INFINITY
  for (const script of group.scripts) {
    for (const instance of script.instances) {
      const timestamp = Date.parse(instance.last.ts)
      if (Number.isFinite(timestamp)) first = Math.min(first, timestamp)
    }
  }
  return first
}

type HookScriptDraft = Omit<HookScriptRow, 'logicalRuns' | 'pending' | 'instances'> & {
  pendingKeys: Set<string>
  responseKeys: Set<string>
  instanceMap: Map<string, HookInstanceRow>
}

type HookGroupDraft = Omit<HookGroup, 'logicalRuns' | 'responses' | 'pending' | 'triggerRuns' | 'scripts'> & {
  scripts: Map<string, HookScriptDraft>
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function hookTimestampMs(value: string): number | undefined {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function nonNegativeDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function hookSource(value: unknown): HookConfiguredCommand['source'] | undefined {
  return value === 'user' || value === 'project' || value === 'local' || value === 'plugin' ? value : undefined
}

function mergedConfiguredCommands(
  previous: HookConfiguredCommand[],
  current: HookConfiguredCommand[] | undefined
): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return [...previous, ...(current ?? [])].filter((candidate) => {
    const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hookEventFailureSummary(e: TraceEvent): string | undefined {
  const input = e.input as Record<string, unknown> | undefined
  const pieces = [
    stringField(input?.stderr),
    stringField(input?.stdout),
    stringField(input?.content),
    stringField(e.output),
    stringField(e.text)
  ]
  const message = pieces.find(Boolean)
  const exitCode = e.hookExitCode ?? (typeof input?.exitCode === 'number' ? input.exitCode : undefined)
  const prefix = exitCode != null ? `exit ${exitCode}` : e.hookOutcome === 'error' ? 'hook error' : undefined
  if (message) {
    const clean = message.replace(/\s+/g, ' ').trim()
    return prefix ? `${prefix}: ${clean}` : clean
  }
  if (prefix) return prefix
  if (e.hookOutcome) return e.hookOutcome
  return undefined
}

function hookTriggerSubject(event: string, trigger: string): string {
  const prefix = `${event}:`
  return trigger.startsWith(prefix) ? trigger.slice(prefix.length) : trigger
}

function hookRunIdentity(event: TraceEvent): string {
  return `${event.runId}\u0000${event.hookId ?? event.id}`
}

function triggerRunsForHook(items: TraceEvent[], event: string, trigger: string): number | null {
  const subject = hookTriggerSubject(event, trigger)
  if (!subject || subject === trigger) return null
  const calls = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'skill' && item.kind !== 'agent') continue
    if (item.stage === 'tool_result' || (item.tool ?? item.name) !== subject) continue
    calls.add(item.toolUseId ?? item.id)
  }
  return calls.size > 0 ? calls.size : null
}

function triggerRunsFromHandlers(scripts: HookScriptRow[]): number | null {
  const runs = scripts.map((script) => script.logicalRuns)
  return runs.length > 0 && runs.every((count) => count === runs[0]) ? runs[0] : null
}

export function aggregateHooks(items: TraceEvent[]): HookSummary {
  const hooks = items.filter((e) => e.kind === 'hook')
  const groups = new Map<string, HookGroupDraft>()
  const commandsByRun = new Map<string, Set<string>>()

  for (const e of hooks) {
    const command = hookCommandFromEvent(e)
    if (!command || !e.hookId) continue
    const event = e.hookEvent ?? e.name ?? 'Hook'
    const trigger = e.hookName ?? e.tool ?? 'hook'
    const runKey = `${event}\u0000${trigger}\u0000${hookRunIdentity(e)}`
    const commands = commandsByRun.get(runKey) ?? new Set<string>()
    commands.add(command)
    commandsByRun.set(runKey, commands)
  }

  for (const e of hooks) {
    const event = e.hookEvent ?? e.name ?? 'Hook'
    const trigger = e.hookName ?? e.tool ?? 'hook'
    const groupKey = `${event}\u0000${trigger}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { key: groupKey, event, trigger, rawEvents: 0, errors: 0, cancelled: 0, toolCalls: 0, scripts: new Map() }
      groups.set(groupKey, group)
    }

    const explicitCommand = hookCommandFromEvent(e)
    const runCommands = e.hookId
      ? commandsByRun.get(`${event}\u0000${trigger}\u0000${hookRunIdentity(e)}`)
      : undefined
    const command = explicitCommand ?? (runCommands?.size === 1 ? [...runCommands][0] : undefined)
    const label = hookCommandLabel(command) ?? trigger
    const scriptKey = `${groupKey}\u0000${command ?? label}`
    let script = group.scripts.get(scriptKey)
    if (!script) {
      script = {
        key: scriptKey,
        event,
        trigger,
        label,
        command,
        rawEvents: 0,
        responses: 0,
        started: 0,
        progress: 0,
        errors: 0,
        cancelled: 0,
        unsuccessful: [],
        pendingKeys: new Set(),
        responseKeys: new Set(),
        instanceMap: new Map()
      }
      group.scripts.set(scriptKey, script)
    }

    const instanceKey = hookRunIdentity(e)
    const input = e.input as Record<string, unknown> | undefined
    const previousInstance = script.instanceMap.get(instanceKey)
    const eventAtMs = hookTimestampMs(e.ts)
    const startedAtMs = e.stage === 'hook_started' && eventAtMs != null
      ? previousInstance?.startedAtMs == null ? eventAtMs : Math.min(previousInstance.startedAtMs, eventAtMs)
      : previousInstance?.startedAtMs
    const completedAtMs = e.stage === 'hook_response' && eventAtMs != null
      ? previousInstance?.completedAtMs == null ? eventAtMs : Math.max(previousInstance.completedAtMs, eventAtMs)
      : previousInstance?.completedAtMs
    const providerDurationMs = nonNegativeDuration(e.durationMs)
      ?? (previousInstance?.durationSource === 'provider' ? previousInstance.durationMs : undefined)
    const observedDurationMs = startedAtMs != null && completedAtMs != null && completedAtMs >= startedAtMs
      ? completedAtMs - startedAtMs
      : undefined
    const durationMs = providerDurationMs ?? observedDurationMs ?? previousInstance?.durationMs
    const durationSource = providerDurationMs != null
      ? 'provider' as const
      : observedDurationMs != null ? 'observed' as const : previousInstance?.durationSource
    script.instanceMap.set(instanceKey, {
      key: instanceKey,
      hookId: e.hookId ?? previousInstance?.hookId,
      command: command ?? previousInstance?.command,
      source: hookSource(input?.source) ?? previousInstance?.source,
      sourcePath: stringField(input?.sourcePath) ?? previousInstance?.sourcePath,
      configuredCommands: mergedConfiguredCommands(
        previousInstance?.configuredCommands ?? [],
        e.hookConfiguredCommands
      ),
      outcome: e.hookOutcome ?? previousInstance?.outcome,
      durationMs,
      durationSource,
      startedAtMs,
      completedAtMs,
      isError: previousInstance?.isError === true || e.isError === true || e.hookOutcome === 'error' || e.hookOutcome === 'failure',
      last: e
    })

    group.rawEvents++
    script.rawEvents++
    if (e.stage === 'hook_response') {
      const responseKey = hookRunIdentity(e)
      const firstResponse = !script.responseKeys.has(responseKey)
      script.responseKeys.add(responseKey)
      script.outcome = e.hookOutcome
      script.exitCode = e.hookExitCode
      if (firstResponse && e.hookOutcome === 'cancelled') {
        group.cancelled++
        script.cancelled++
        script.lastCancelled = e
      }
      if (firstResponse && (e.isError || e.hookOutcome === 'error' || e.hookOutcome === 'failure' || e.hookOutcome === 'cancelled')) {
        script.unsuccessful.push(e)
      }
    } else {
      script.pendingKeys.add(hookRunIdentity(e))
      if (e.stage === 'hook_started') script.started++
      else script.progress++
    }
    if (e.isError) {
      group.errors++
      script.errors++
      script.lastError = e
      script.failureSummary = hookEventFailureSummary(e)
    }
    group.last = e
    script.last = e
  }

  const finalized = [...groups.values()].map((g) => {
    const scripts = [...g.scripts.values()]
      .map((s) => {
        const pending = [...s.pendingKeys].filter((key) => !s.responseKeys.has(key)).length
        const logicalRuns = new Set([...s.pendingKeys, ...s.responseKeys]).size
        const responses = s.responseKeys.size
        const instances = [...s.instanceMap.values()].sort(
          (a, b) => Date.parse(a.last.ts) - Date.parse(b.last.ts) || a.key.localeCompare(b.key)
        )
        const { pendingKeys: _pendingKeys, responseKeys: _responseKeys, instanceMap: _instanceMap, ...row } = s
        return { ...row, responses, pending, logicalRuns, instances }
      })
      .sort((a, b) => b.logicalRuns - a.logicalRuns || b.rawEvents - a.rawEvents || a.label.localeCompare(b.label))
    const responses = scripts.reduce((sum, s) => sum + s.responses, 0)
    const pending = scripts.reduce((sum, s) => sum + s.pending, 0)
    const logicalRuns = responses + pending
    const toolTriggerRuns = triggerRunsForHook(items, g.event, g.trigger)
    const triggerRuns = toolTriggerRuns ?? triggerRunsFromHandlers(scripts)
    return {
      ...g,
      toolCalls: toolTriggerRuns ?? 0,
      triggerRuns,
      scripts,
      responses,
      pending,
      logicalRuns
    }
  })

  finalized.sort(
    (a, b) =>
      hookLifecycleRank(a.event) - hookLifecycleRank(b.event) ||
      hookGroupFirstTimestamp(a) - hookGroupFirstTimestamp(b) ||
      a.event.localeCompare(b.event) ||
      a.trigger.localeCompare(b.trigger)
  )

  return {
    rawEvents: hooks.length,
    logicalRuns: finalized.reduce((sum, g) => sum + g.logicalRuns, 0),
    responses: finalized.reduce((sum, g) => sum + g.responses, 0),
    pending: finalized.reduce((sum, g) => sum + g.pending, 0),
    groups: finalized
  }
}
