import { available, unavailable, type Evidence } from '../shared/turn-record'
import type { NativeTranscriptRun } from '../main/bootstrap/run-host'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import {
  captureTranscriptInterval, readTranscriptExtent, type TranscriptExtent, type TranscriptSource
} from '../host-runtime/orchestration/transcript-interval'
import { locateOwnedTranscript } from './orchestration-native-source'

export function recordNativeRunTranscript(
  sink: EventSink, runId: string, transcript: Evidence<string>, log: (message: string) => void
): void {
  if (!sink.handle.db.open || sink.isWriteIndeterminate()) return
  try {
    if (!sink.getRun(runId)) return
    const payload = { runId, step: 'transcript_referenced' as const, transcript, evidence: transcript.source }
    const result = sink.execute({
      type: 'run.effect_result', commandId: `effect:p4-${runId}:transcript`, actor: 'system',
      scope: 'system', at: Date.now(), payload, payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (result.kind === 'rejected') log(`daemon.transcript-rejected ${result.reason}`)
  } catch (error) {
    log(`daemon.transcript-record ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`)
  }
}

/** Delimit the append at the Provider boundary. Catalog scans have no run attribution. */
export async function observeNativeRunTranscript(
  homeDir: string,
  input: NativeTranscriptRun,
  save: (transcript: Promise<Evidence<string>>) => void,
  log: (message: string) => void
): Promise<(sessionId: string | undefined) => Promise<void>> {
  const { providerId, cwd, resume } = input
  const omit = (reason: string): void => save(Promise.resolve(unavailable(reason)))
  if (providerId !== 'claude' && providerId !== 'pi') {
    return async () => { omit('provider_has_no_native_transcript') }
  }

  const lookup = (sessionId: string) => locateOwnedTranscript(homeDir, cwd, providerId, sessionId)
  let initial: TranscriptSource | undefined
  let before: TranscriptExtent | undefined
  try {
    initial = resume ? await lookup(resume) : undefined
    before = initial ? await readTranscriptExtent(initial) : undefined
  } catch (error) {
    log(`daemon.transcript-frontier ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`)
    return async () => { omit('transcript_frontier_unavailable') }
  }
  const startedAt = BigInt(Date.now()) * 1_000_000n
  return async (sessionId) => {
    try {
      if (!sessionId) { omit('native_session_unavailable'); return }
      const source = await lookup(sessionId)
      if (!source) { omit('source_removed'); return }
      const through = await readTranscriptExtent(source)
      if (!through) { omit('source_removed'); return }
      const resumedHere = initial?.path === source.path && before !== undefined
      if (!resumedHere && (resume === sessionId || through.birthtimeNs <= startedAt)) {
        omit('transcript_frontier_unavailable')
        return
      }
      // Only the stat frontier needs to precede normal run settlement. Hashing
      // a bounded range can finish independently of the turn and its archive.
      save(captureTranscriptInterval(source, resumedHere ? before : undefined, through).then(
        (transcript) => {
          // The bytes are proven. An external writer could have appended in the
          // same interval, so attribution to this run is an inference.
          return transcript.value ? available(transcript.value, transcript.source, 'inferred') : transcript
        },
        (error: NodeJS.ErrnoException) => {
          log(`daemon.transcript-capture ${error.code ?? 'unavailable'}`)
          return unavailable('transcript_read_failed')
        }
      ))
    } catch (error) {
      log(`daemon.transcript-finish ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`)
      omit('transcript_read_failed')
    }
  }
}
