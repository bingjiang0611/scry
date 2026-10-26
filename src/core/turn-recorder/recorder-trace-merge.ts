import { join } from 'node:path'
import { type TraceEvent, HOOK_DELIVERY_STAGE } from '../../shared/trace.js'
import { readJson, listFiles } from './io.js'
import { stableHash } from './store.js'
import type { StoredLifecycleEvent } from './recorder-contracts.js'

export async function readStoredEvents(path: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  for (const name of await listFiles(path)) {
    if (!name.endsWith('.json')) continue
    const stored = await readJson<StoredLifecycleEvent>(join(path, name))
    if (stored?.schemaVersion === 1 && Array.isArray(stored.traceEvents)) events.push(...stored.traceEvents)
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts))
}

export function dedupeTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    const logicalToolKey = event.kind === 'skill'
      ? event.toolUseId
        ? { lifecycle: 'skill', name: event.name ?? event.tool ?? 'unknown', toolUseId: event.toolUseId }
        : {
            lifecycle: 'skill',
            name: event.name ?? event.tool ?? 'unknown',
            messageId: event.messageId,
            source: (event.input as Record<string, unknown> | undefined)?.source,
            id: event.id
          }
      : event.toolUseId
      ? {
          lifecycle: event.stage === 'tool_result' ? 'result' : 'start',
          toolUseId: event.toolUseId
        }
      : undefined
    const key = stableHash(logicalToolKey ?? {
      kind: event.kind,
      stage: event.stage,
      hookId: event.hookId,
      hookOutcome: event.hookOutcome,
      tool: event.tool,
      text: event.text,
      ts: event.ts,
      // Concurrent repository snapshots can finish in the same millisecond. Their
      // identity is the requested/resolved repository and baseline, not just stage/time.
      diff: event.turnDiff ? {
        requestedRoot: event.turnDiff.requestedRoot,
        repoRoot: event.turnDiff.repoRoot,
        scope: event.turnDiff.scope,
        beforeAt: event.turnDiff.beforeAt,
        status: event.turnDiff.status
      } : undefined
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toolEventKey(event: TraceEvent): string | undefined {
  if (!event.toolUseId) return undefined
  return event.stage === 'tool_result' ? `result:${event.toolUseId}` : `start:${event.toolUseId}`
}

function isLogicalCallEvent(event: TraceEvent): boolean {
  return event.stage === 'tool_result' ||
    (event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name))
}

export function mergeTurnTraceEvents(
  lifecycle: TraceEvent[],
  transcript: TraceEvent[],
  transcriptToolStreamComplete = true
): TraceEvent[] {
  const transcriptToolKeys = new Set(transcript.map(toolEventKey).filter((key): key is string => !!key))
  const transcriptHasLogicalCalls = transcript.some((event) => isLogicalCallEvent(event) && event.stage !== 'tool_result')
  const transcriptCallsAuthoritative = transcriptToolStreamComplete && transcriptHasLogicalCalls
  const transcriptHasAssistant = transcript.some((event) => event.kind === 'model' && event.stage === 'text')
  const transcriptHasUsage = transcript.some((event) => event.kind === 'harness' && event.stage === 'result')
  // 带脚本身份的 transcript hook 运行是权威证据；此时 recorder 自己的投递事件只会重复计数。
  const transcriptHasHookRuns = transcript.some((event) => event.kind === 'hook' && event.stage !== HOOK_DELIVERY_STAGE)
  const filteredLifecycle = lifecycle.filter((event) => {
    if (transcriptCallsAuthoritative && isLogicalCallEvent(event)) return false
    const key = toolEventKey(event)
    if (key && transcriptToolKeys.has(key)) return false
    if (transcriptHasAssistant && event.kind === 'model' && event.stage === 'text') return false
    if (transcriptHasUsage && event.kind === 'harness' && event.stage === 'result') return false
    if (transcriptHasHookRuns && event.kind === 'hook' && event.stage === HOOK_DELIVERY_STAGE) return false
    if (transcript.length && event.kind === 'skill' && !event.toolUseId) return false
    return true
  })
  return dedupeTraceEvents([...filteredLifecycle, ...transcript])
}
