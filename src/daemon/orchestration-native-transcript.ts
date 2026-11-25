import type { Evidence } from '../shared/turn-record'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { observeNativeRunTranscript } from './orchestration-run-transcript'
import type { NativeTranscriptRun } from '../main/bootstrap/run-host'

export interface NativeTranscriptObserverDeps {
  sink: EventSink
  resolveCanonical: (runId: string) => string
  pendingTranscripts: Map<string, Promise<Evidence<string>>>
  log: (line: string) => void
}

/** Extracted from orchestration-authority.ts to keep that file within the 20 KB budget. */
export function observeAuthorityNativeTranscript(
  deps: NativeTranscriptObserverDeps,
  homeDir: string,
  run: NativeTranscriptRun
): ReturnType<typeof observeNativeRunTranscript> | undefined {
  const { sink, resolveCanonical, pendingTranscripts, log } = deps
  if (!sink.handle.db.open || sink.isWriteIndeterminate()) return undefined
  const runId = resolveCanonical(run.ledgerRunId ?? run.runId)
  return observeNativeRunTranscript(homeDir, run, (transcript) => {
    if (!sink.handle.db.open || sink.isWriteIndeterminate()) return
    const current = sink.getRun(runId)
    if (current?.lifecycle === 'dispatched' && current.cwd === run.cwd && current.provider === run.providerId) {
      pendingTranscripts.set(runId, transcript)
    }
  }, log)
}
