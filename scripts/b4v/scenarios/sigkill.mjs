// B4-V「daemon 被 SIGKILL（被杀前已有一个 dispatched run）」: the daemon comes back; the
// run that was dispatched becomes failed(host_restarted) and is not dispatched again; a
// write whose reply died with the daemon is reported as unknown, not as done or refused.
//
// The unconfirmed write is made deterministic, not timed: the daemon is frozen with
// SIGSTOP (its identity verified first), the window sends a stop for the run, and only
// then is the frozen daemon SIGKILLed. The stop request is on the wire and can never be
// answered.
import { attempt, sleep } from '../app.mjs'
import { daemonHolder, waitForDaemonHolder } from '../fixture.mjs'
import { COMPLETE_PROMPT, HOLD_PROMPT, Abort, openChecked, runScenario, startRun, waitLedger, waitRun } from '../kit.mjs'
import { failedHostRestarted } from '../ledger.mjs'
import { unconfirmedWriteVerdict } from '../outcomes.mjs'
import { signalVerified, waitGone } from '../process-identity.mjs'
import { recordStep } from '../report.mjs'

export const plan = [
  { id: 'run-dispatched', expected: 'a run that waits for an interrupt is run_dispatched in the daemon ledger and showing output' },
  { id: 'write-in-flight', expected: 'with the daemon frozen (SIGSTOP), a stop for that run is sent and stays unanswered' },
  { id: 'daemon-killed', expected: 'SIGKILL to the verified daemon; its identity is gone' },
  { id: 'daemon-relaunched', expected: 'a new verified daemon holds daemon.lock within 60 s (different identity)' },
  { id: 'run-failed-host-restarted', expected: 'the ledger records run_failed for the run with detail host_restarted' },
  { id: 'not-redispatched', expected: 'after a fence run settles on the new daemon, the run has exactly one run_dispatched' },
  { id: 'unconfirmed-write-unknown', expected: 'the in-flight stop settles as daemon_outcome_unknown / daemon_stop_not_confirmed / daemon_submit_unknown, never true/false' },
  { id: 'app-view-not-running', expected: 'the App no longer shows the run as running: not listed active, or done with an error' }
]

const PENDING_STOP = (runId) => `(() => {
  window.__b4vStop = { state: 'pending' }
  window.scry.stop(${JSON.stringify(runId)}).then(
    (value) => { window.__b4vStop = { state: 'resolved', value } },
    (error) => { window.__b4vStop = { state: 'rejected', error: String(error && error.message || error) } })
  return true
})()`

export async function run(ctx) {
  return runScenario(ctx, { id: 'sigkill', title: 'daemon 被 SIGKILL', mode: 'daemon', label: 'sigkill', plan }, async ({ scenario, fixture }) => {
    const app = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-1' })
    const held = await startRun(app, { prompt: HOLD_PROMPT('sigkill'), cwd: fixture.workspace })
    if (!held.ok) throw new Abort(`hold start refused: ${held.error}`)
    const dispatched = await waitLedger(fixture, held, (summary) => summary.dispatches >= 1, 15_000)
    const visible = await waitRun(app, held.runId, (view) => view.output === true, 15_000)
    recordStep(scenario, { id: 'run-dispatched', actual: { ledger: dispatched.summary, view: visible.value },
      pass: dispatched.ok && dispatched.summary.terminal === null && visible.ok })
    if (!dispatched.ok) throw new Abort('the hold run never reached run_dispatched')

    const holder = daemonHolder(fixture)
    if (holder.verdict !== 'verified') throw new Abort(`daemon holder not verified before SIGSTOP: ${holder.verdict}`)
    const frozen = signalVerified(holder.identity, 'SIGSTOP')
    if (!frozen.signalled) throw new Abort(`could not freeze the verified daemon: ${frozen.verdict}`)
    await app.evaluate(PENDING_STOP(held.runId))
    // A bounded wait that proves the negative: a frozen daemon cannot answer, so the stop
    // must still be pending afterwards. It does not make anything pass.
    await sleep(500)
    const pending = await attempt(app, 'window.__b4vStop')
    recordStep(scenario, { id: 'write-in-flight', actual: { frozen, stop: pending.ok ? pending.value : pending },
      pass: pending.ok && pending.value?.state === 'pending' })

    const killed = signalVerified(holder.identity, 'SIGKILL')
    const gone = await waitGone([holder.identity], 10_000)
    recordStep(scenario, { id: 'daemon-killed', actual: { killed, remaining: gone.map((row) => row.pid) },
      pass: killed.signalled && gone.length === 0 })

    const relaunched = await waitForDaemonHolder(fixture, { timeoutMs: 60_000, differentFrom: holder.lock })
    recordStep(scenario, { id: 'daemon-relaunched',
      actual: { verdict: relaunched?.verdict, pid: relaunched?.lock?.pid ?? null, startedBy: relaunched?.lock?.startedBy ?? null, previousPid: holder.lock.pid },
      pass: relaunched?.verdict === 'verified' && relaunched.lock.identityKey !== holder.lock.identityKey })

    const failed = await waitLedger(fixture, held, (summary) => summary.terminal !== null, 60_000)
    recordStep(scenario, { id: 'run-failed-host-restarted', actual: failed.summary, evidence: { ledger: failed.path },
      pass: failed.ok && failedHostRestarted(failed.summary) })

    // Fence: a new run that settles on the new daemon proves its startup recovery is over,
    // so a second dispatch of the old run would already be in the ledger.
    const fence = await startRun(app, { prompt: COMPLETE_PROMPT('sigkill-fence'), cwd: fixture.workspace })
    const fenced = fence.ok ? await waitLedger(fixture, fence, (summary) => summary.terminal !== null, 60_000) : { ok: false }
    const recount = await waitLedger(fixture, held, () => true, 5_000)
    recordStep(scenario, { id: 'not-redispatched',
      actual: { dispatches: recount.summary?.dispatches ?? null, exact: recount.summary?.dispatchCountExact ?? null, fence: fence.ok ? fenced.summary : fence },
      pass: fenced.ok && recount.ok && recount.summary.dispatches === 1 && recount.summary.dispatchCountExact === true })

    const settledStop = await waitStop(app, 90_000)
    const verdict = unconfirmedWriteVerdict(settledStop)
    recordStep(scenario, { id: 'unconfirmed-write-unknown', actual: verdict, pass: verdict.pass })

    const view = await waitRun(app, held.runId, (observed) => observed.listed === false || (observed.done === true && Boolean(observed.error)), 30_000)
    recordStep(scenario, { id: 'app-view-not-running', actual: view.value, pass: view.ok })
  })
}

async function waitStop(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = await attempt(app, 'window.__b4vStop')
  while (last.ok && last.value?.state === 'pending' && Date.now() < deadline) {
    await sleep(200)
    last = await attempt(app, 'window.__b4vStop')
  }
  return last.ok ? last.value : { state: 'unreadable', error: last.error }
}
