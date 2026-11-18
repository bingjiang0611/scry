// B4-V「同 provider/profile 互斥」: on the same provider/profile and workspace, a second
// start must behave exactly as it does in-process. The product's conflict domain is the
// session, not the workspace (run-admission.ts: different sessions in one cwd may run in
// parallel; overlap is marked by diff evidence, not serialized), so two cases are run:
//
//   same session   the second start continues the first run's session while it is live:
//                  it must queue or be refused
//   new session    the second start opens a new session: whatever in-process does
//                  (parallel by design), the daemon must do the same
//
// Authentication-versus-run exclusion (ProviderOperationGate) needs a Provider login the
// smoke Provider does not have; it is reported as not-run. The switch-off control runs the
// identical sequence first and the daemon scenario compares outcome classes.
import { attempt } from '../app.mjs'
import { HOLD_PROMPT, COMPLETE_PROMPT, Abort, openChecked, runScenario, startRun, waitLedger, waitRun } from '../kit.mjs'
import { classifySecondStart, exclusionHolds } from '../outcomes.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

const commonPlan = [
  { id: 'first-run-live', expected: 'the first run (same provider/profile, same workspace) is live, showing output, and names its session' },
  { id: 'same-session-excluded', expected: 'a second start into the first run\'s live session is refused, or queued until the first ends (never parallel)' },
  { id: 'new-session-observed', expected: 'a second start that opens a new session is classified (refused / queued / parallel); the class is compared with the control' }
]
export const daemonPlan = [
  ...commonPlan,
  { id: 'matches-in-process', expected: 'both outcome classes (same session, new session) equal the switch-off control' },
  { id: 'auth-versus-run', expected: 'a Provider authentication while a run is live on the same profile is blocked (and vice versa)' },
  { id: 'local-plus-remote', expected: 'a local start and a remote-device start on the same profile and session: the second queues or is refused' }
]

const WINDOW_MS = 10_000

async function second(app, fixture, mode, first, extra, tag) {
  const started = await startRun(app, { prompt: COMPLETE_PROMPT(tag), cwd: fixture.workspace, extra })
  const observed = { startError: started.ok ? null : started.error }
  if (!started.ok && mode === 'daemon') {
    // Recorded and then failed or cancelled is a refusal; recorded and still pending or
    // settled means the error the window showed was not the daemon's decision.
    const ledger = await waitLedger(fixture, started, (summary) => summary.terminal !== null, 5_000)
    observed.recordedDespiteError = Boolean(ledger.summary) && !['failed', 'cancelled'].includes(ledger.summary.terminal)
    observed.ledger = ledger.summary
  }
  if (started.ok) observed.whileFirstLive = (await waitRun(app, started.runId, (view) => view.done === true, WINDOW_MS)).value
  observed.firstStillLive = (await waitRun(app, first.runId, (view) => view.done !== true, 1_000)).ok
  return { started, observed }
}

async function exercise(ctx, scenario, fixture, mode) {
  const app = await openChecked(ctx, scenario, fixture, { mode, label: 'app-1' })
  const first = await startRun(app, { prompt: HOLD_PROMPT('exclusion-first'), cwd: fixture.workspace })
  if (!first.ok) throw new Abort(`first start refused: ${first.error}`)
  const live = await waitRun(app, first.runId, (view) => view.output === true && view.done !== true && Boolean(view.sessionId), 15_000)
  recordStep(scenario, { id: 'first-run-live', actual: live.value, pass: live.ok })
  if (!live.ok) throw new Abort('the first run never became live with a session')

  const same = await second(app, fixture, mode, first, { expectedExternalSessionId: live.value.sessionId }, 'exclusion-same')
  const fresh = await second(app, fixture, mode, first, { expectedExternalSessionId: null }, 'exclusion-new')

  const stopped = await attempt(app, `window.scry.stop(${JSON.stringify(first.runId)})`)
  for (const attemptOf of [same, fresh]) {
    if (attemptOf.started.ok && attemptOf.observed.whileFirstLive?.done !== true) {
      attemptOf.observed.afterFirstStopped = (await waitRun(app, attemptOf.started.runId, (view) => view.done === true, 30_000)).value
    }
  }
  const sameClass = classifySecondStart(same.observed)
  recordStep(scenario, { id: 'same-session-excluded', actual: { ...sameClass, observed: same.observed, firstStop: stopped }, pass: exclusionHolds(sameClass) })
  const freshClass = classifySecondStart(fresh.observed)
  recordStep(scenario, { id: 'new-session-observed', actual: { ...freshClass, observed: fresh.observed }, pass: freshClass.outcome !== 'unknown' })
  return { sameSession: sameClass.outcome, newSession: freshClass.outcome }
}

export async function run(ctx) {
  let control = null
  if (!ctx.options.noControls) {
    await runScenario(ctx, { id: 'mutual-exclusion-control', title: '同 profile 互斥（开关关闭对照）', mode: 'switch-off', label: 'excl-off', plan: commonPlan },
      async ({ scenario, fixture }) => { control = await exercise(ctx, scenario, fixture, 'switch-off') })
  }
  return runScenario(ctx, { id: 'mutual-exclusion', title: '同 provider/profile 互斥', mode: 'daemon', label: 'excl', plan: daemonPlan }, async ({ scenario, fixture }) => {
    const outcome = await exercise(ctx, scenario, fixture, 'daemon')
    if (!control || Object.values(control).includes('unknown')) {
      recordNotRun(scenario, { id: 'matches-in-process', reason: control ? 'the switch-off control could not classify its own outcomes' : 'switch-off control did not complete (--no-controls or it aborted)' })
    } else {
      recordStep(scenario, { id: 'matches-in-process', actual: { daemon: outcome, control },
        pass: outcome.sameSession === control.sameSession && outcome.newSession === control.newSession })
    }
    recordNotRun(scenario, { id: 'auth-versus-run', reason: 'the smoke Provider has no login flow, so ProviderOperationGate authentication cannot be exercised from the window; covered by provider-operation-gate / remote-run-policy unit tests; a real Provider check belongs to S0-2' })
    recordNotRun(scenario, { id: 'local-plus-remote', reason: 'no paired-device fixture against a daemon-mode host exists in this harness; the local same-session case above stands in for it' })
  })
}
