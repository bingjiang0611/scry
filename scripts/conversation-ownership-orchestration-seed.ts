/**
 * Seeds the orchestration event log of an isolated userData with one dispatched
 * conversation run, as a daemon that crashed after dispatch leaves it.
 *
 * With orchestration on (the default), a pending conversation turn whose run the event
 * log never saw provably reached no Provider and settles `not_sent` (Decision G). A turn
 * whose run the log saw dispatched may have reached one, so startup recovery interrupts
 * the run and the turn settles `unknown`: the state the ownership smoke needs to prove
 * that a legacy resume of an unconfirmed delivery is refused. The facts are written
 * through the production EventSink, and nothing else.
 *
 * Runs with Electron as Node (the daemon's runtime, so its SQLite binding), against the
 * smoke's temporary userData only, never inside the App.
 */
import { EventSink } from '../src/host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../src/host-runtime/orchestration/canonical-json'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const userDataDir = argument('--user-data')
const runId = argument('--run-id')
const conversationId = argument('--conversation')
const cwd = argument('--cwd')
const at = Date.now() - 1_000
const sink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
try {
  const submit = {
    runId, sessionKey: conversationId, ordinal: 1, provider: 'codex', profile: null, cwd,
    claimMode: 'immediate' as const, pendingTtlMs: 30_000, origin: 'local' as const, isConversationRun: true
  }
  const dispatched = { runId, step: 'admitted_and_dispatched' as const }
  for (const command of [
    { type: 'run.submit' as const, commandId: `seed-${runId}`, actor: 'system', scope: 'local' as const, at, payload: submit },
    { type: 'run.effect_result' as const, commandId: `seed-${runId}-dispatched`, actor: `effect:seed-${runId}`, scope: 'system' as const, at: at + 1, payload: dispatched }
  ]) {
    const result = sink.execute({ ...command, payloadSha256: sha256Hex(canonicalJson(command.payload)) } as Parameters<EventSink['execute']>[0])
    if (result.kind !== 'accepted') throw new Error(`seed ${command.type} was not accepted: ${JSON.stringify(result)}`)
  }
} finally {
  sink.close()
}
