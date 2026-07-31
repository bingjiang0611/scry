import type { TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import type { RuntimeFailureBrief, RuntimeProvider } from '../shared/runtime'

export function ensureFailedTerminalResult(
  items: TraceEvent[],
  args: {
    runId: string
    message: string
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    cwd?: string
    hint?: string
    brief?: RuntimeFailureBrief
    id: string
    ts: string
  }
): { terminal: TraceEvent; corrections: TraceEvent[]; created: boolean } {
  const indices = items
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === 'harness' && event.stage === 'result')
    .map(({ index }) => index)
  const canonicalIndex = indices.at(-1)
  const brief: RuntimeFailureBrief = args.brief ?? {
    provider: args.runtimeProvider,
    stage: 'runtime',
    cwd: args.cwd,
    nextAction: args.hint || '检查 Provider 日志后重试'
  }
  const terminal: TraceEvent = canonicalIndex == null
    ? {
        id: args.id,
        ts: args.ts,
        runId: args.runId,
        kind: 'harness',
        stage: 'result'
      }
    : items[canonicalIndex]
  terminal.isError = true
  terminal.text = terminal.text || args.message
  terminal.providerId = terminal.providerId ?? args.providerId
  terminal.runtimeProvider = terminal.runtimeProvider ?? args.runtimeProvider
  terminal.runtimeFailureStage = brief.stage
  terminal.runtimeMetadata = {
    ...(terminal.runtimeMetadata ?? {}),
    brief,
    errorMessage: args.message
  }
  const corrections: TraceEvent[] = []
  if (canonicalIndex == null) items.push(terminal)
  else {
    for (const index of indices.slice(0, -1)) {
      const duplicate = items[index]
      duplicate.stage = 'result_superseded'
      duplicate.runtimeMetadata = {
        ...(duplicate.runtimeMetadata ?? {}),
        supersededBy: terminal.id
      }
      corrections.push(duplicate)
    }
  }
  corrections.push(terminal)
  return { terminal, corrections, created: canonicalIndex == null }
}
