// B4-V「重新打开 App」: the new App attaches to the daemon that is already running (same
// pid, no second daemon), picks up a live run by cursor, and shows any gap honestly.
//
// The live run is the seeded question fixture: 1000 progress events and a text item are
// emitted at once, then the run waits on a question, so it is still live when the second
// App arrives and holds more content than a bounded snapshot may carry.
import { attempt, quitApp } from '../app.mjs'
import { daemonHolder, fixtureDaemonProcesses } from '../fixture.mjs'
import { Abort, SEEDED_QUESTION_PROMPT, openChecked, runScenario, startRun, waitLedger, waitRun } from '../kit.mjs'
import { continuityVerdict } from '../outcomes.mjs'
import { recordStep } from '../report.mjs'

export const plan = [
  { id: 'live-run-before-close', expected: 'the seeded run is run_dispatched and waiting on its question; the first App has shown its content' },
  { id: 'app-quit', expected: 'the first App quits gracefully' },
  { id: 'same-daemon', expected: 'the second App attaches to the same daemon: daemon.lock names the same verified pid and identity' },
  { id: 'single-daemon', expected: 'exactly one daemon and at most one supervisor carry this state directory' },
  { id: 'run-adopted', expected: 'the second App lists the live run as active (adopted from the daemon)' },
  { id: 'cursor-continuity', expected: 'every item the first App showed is present exactly once in the second App, or the stream health flags the gap (degraded / resyncRequired / skippedEvents)' },
  { id: 'run-controllable', expected: 'a stop from the second App ends the run; the ledger records a terminal state' }
]

const SNAPSHOT_FOCUSED = `window.scry.focusedRunSnapshot().then((run) => run ? { runId: run.runId, items: run.items.map((item) => ({ id: item.id })) } : null)`

// The second App may know the run by the bound runtime id the first App saw, or by the
// ledger id it adopted from the daemon; either is the same run (linked by the intent id).
function subscribeExpression(candidateIds) {
  return `(async () => {
    const candidates = ${JSON.stringify(candidateIds)}
    const runs = await window.scry.activeRuns()
    const listed = runs.find((run) => candidates.includes(run.runId)) || null
    const runId = listed ? listed.runId : candidates[0]
    const result = await window.scry.runTraces.subscribe({ runId, subscriptionId: 'b4v-reopen-' + Date.now() })
    return {
      runId,
      listed: Boolean(listed),
      listedIds: runs.map((run) => run.runId),
      status: result.status,
      health: result.health || null,
      items: result.run ? result.run.items.map((item) => ({ id: item.id })) : (listed ? listed.items.map((item) => ({ id: item.id })) : [])
    }
  })()`
}

export async function run(ctx) {
  return runScenario(ctx, { id: 'reopen', title: '重新打开 App', mode: 'daemon', label: 'reopen', plan }, async ({ scenario, fixture }) => {
    const first = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-1' })
    const before = daemonHolder(fixture)
    const seeded = await startRun(first, { prompt: SEEDED_QUESTION_PROMPT, cwd: fixture.workspace })
    if (!seeded.ok) throw new Abort(`seeded start refused: ${seeded.error}`)
    const dispatched = await waitLedger(fixture, seeded, (summary) => summary.dispatches >= 1, 15_000)
    const asked = await waitRun(first, seeded.runId, (view) => view.pendingQuestions > 0 && view.output === true, 30_000)
    const shown = await attempt(first, SNAPSHOT_FOCUSED)
    const beforeItems = shown.ok && shown.value?.runId === seeded.runId ? shown.value.items : []
    recordStep(scenario, { id: 'live-run-before-close',
      actual: { ledger: dispatched.summary, view: asked.value, itemsShown: beforeItems.length },
      pass: dispatched.ok && dispatched.summary.terminal === null && asked.ok && beforeItems.length > 0 })
    if (!dispatched.ok || !asked.ok) throw new Abort('the seeded run never became live with its question')

    const quit = await quitApp(first, fixture)
    recordStep(scenario, { id: 'app-quit', actual: quit, pass: quit.graceful === true && quit.remaining.length === 0 })

    const second = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-2', isolation: false })
    const after = daemonHolder(fixture)
    recordStep(scenario, { id: 'same-daemon',
      actual: { before: { pid: before.lock?.pid, identityKey: before.lock?.identityKey }, after: { pid: after.lock?.pid, identityKey: after.lock?.identityKey, verdict: after.verdict } },
      pass: after.verdict === 'verified' && after.lock.identityKey === before.lock?.identityKey })

    const processes = fixtureDaemonProcesses(fixture)
    recordStep(scenario, { id: 'single-daemon',
      actual: processes.status === 'available'
        ? { daemons: processes.daemon.map((row) => row.pid), supervisors: processes.supervisor.map((row) => row.pid) }
        : processes,
      pass: processes.status === 'available' && processes.daemon.length === 1 && processes.supervisor.length <= 1 &&
        processes.daemon[0].pid === before.lock?.pid })

    const candidates = [seeded.runId, dispatched.summary.runId].filter((id, index, all) => id && all.indexOf(id) === index)
    const adopted = await attempt(second, subscribeExpression(candidates))
    const view = adopted.ok ? adopted.value : null
    recordStep(scenario, { id: 'run-adopted', actual: view ? { listed: view.listed, listedIds: view.listedIds, status: view.status } : adopted,
      pass: Boolean(view?.listed) })
    const continuity = continuityVerdict({ before: beforeItems, after: view?.items ?? [], health: view?.health })
    recordStep(scenario, { id: 'cursor-continuity', actual: { ...continuity, health: view?.health ?? null }, pass: continuity.pass })

    const stopped = await attempt(second, `window.scry.stop(${JSON.stringify(view?.runId ?? seeded.runId)})`)
    const ended = await waitLedger(fixture, seeded, (summary) => summary.terminal !== null, 30_000)
    recordStep(scenario, { id: 'run-controllable', actual: { stop: stopped, ledger: ended.summary },
      pass: stopped.ok && stopped.value === true && ended.ok })
  })
}
