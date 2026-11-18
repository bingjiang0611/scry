// B4-V「退出 Scry 与后台服务」: with a run in progress the action asks again before doing
// anything; without one it ends the App and the daemon and leaves nothing behind: no
// process carrying this state directory, no daemon.lock / scry-userdata.lock / sockets /
// remote leases, no shell the scenario started.
//
// The action is built by the S0-1 lane. Until it exists on window.scry, every step after
// detection is not-run; the scenario never invents a substitute (killing the daemon from
// here would test this script, not the product).
import { API_TREE_EXPRESSION, callExpression, findAction, functionPaths } from '../api-detect.mjs'
import { attempt, sleep } from '../app.mjs'
import { daemonHolder, fixtureLeftovers } from '../fixture.mjs'
import { HOLD_PROMPT, Abort, openChecked, runScenario, startRun, startTerminal, waitLedger } from '../kit.mjs'
import { waitGone } from '../process-identity.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

export const plan = [
  { id: 'action-present', expected: 'S0-1: a「退出 Scry 与后台服务」action is reachable from the window (window.scry)' },
  { id: 'confirm-with-active-run', expected: 'with a dispatched run, invoking the action does not quit yet: App, daemon and run are all still alive 5 s later (a second confirmation is required)' },
  { id: 'quit-without-run', expected: 'with no active run, the action ends the App main and the daemon within 30 s' },
  { id: 'no-leftover-processes', expected: 'no process carries this state directory, and the scenario\'s shell is gone' },
  { id: 'no-leftover-files', expected: 'no daemon.lock, scry-userdata.lock, local.sock, enroll.sock or remote lease file remains' }
]

const CALL_TIMEOUT_MS = 15_000

async function callBounded(app, path) {
  return Promise.race([
    attempt(app, callExpression(path)),
    new Promise((done) => setTimeout(() => done({ ok: false, error: `call_timeout_${CALL_TIMEOUT_MS}ms` }), CALL_TIMEOUT_MS))
  ])
}

export async function run(ctx) {
  return runScenario(ctx, { id: 'quit-all', title: '退出 Scry 与后台服务', mode: 'daemon', label: 'quit', plan }, async ({ scenario, fixture }) => {
    const app = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-1' })
    const tree = await attempt(app, API_TREE_EXPRESSION)
    const action = findAction(tree.ok ? functionPaths(tree.value) : [], 'quit-all', ctx.options.quitApi)
    if (action.status !== 'found') {
      const reason = action.status === 'ambiguous'
        ? `several candidates (${action.candidates.join(', ')}); pass --quit-api <path> to choose`
        : 'no quit-all action on window.scry yet (S0-1 lane builds it)'
      recordNotRun(scenario, { id: 'action-present', reason, needsProductHook: 'window.scry quit App + daemon action (S0-1)' })
      return
    }
    recordStep(scenario, { id: 'action-present', actual: action, pass: true })

    const terminal = await startTerminal(app, fixture, 'b4v-quit')
    const held = await startRun(app, { prompt: HOLD_PROMPT('quit'), cwd: fixture.workspace })
    if (!held.ok) throw new Abort(`hold start refused: ${held.error}`)
    const dispatched = await waitLedger(fixture, held, (summary) => summary.dispatches >= 1, 15_000)
    if (!dispatched.ok) throw new Abort('the hold run never reached run_dispatched')
    const holder = daemonHolder(fixture)
    const firstCall = await callBounded(app, action.path)
    // The negative needs time to show: a quit that proceeds without asking would be under
    // way within this window. It does not make anything pass by itself.
    await sleep(5_000)
    const after = daemonHolder(fixture)
    const runState = await waitLedger(fixture, held, () => true, 2_000)
    const confirmed = !app.exited && after.verdict === 'verified' && after.lock.identityKey === holder.lock?.identityKey &&
      runState.summary?.terminal === null
    if (!firstCall.ok && /call_timeout/.test(String(firstCall.error)) && !app.exited) {
      recordNotRun(scenario, { id: 'confirm-with-active-run',
        reason: 'the call did not return within 15 s; a native confirmation dialog is probably waiting and needs a manual click (record what it says)',
        evidence: { call: firstCall, appAlive: !app.exited, daemon: after.verdict, run: runState.summary } })
    } else {
      recordStep(scenario, { id: 'confirm-with-active-run',
        actual: { call: firstCall, appAlive: !app.exited, daemon: after.verdict, run: runState.summary }, pass: confirmed })
    }
    if (app.exited) throw new Abort('the App quit with a run in progress; the no-run case cannot be exercised on this instance')

    await attempt(app, `window.scry.stop(${JSON.stringify(held.runId)})`)
    await waitLedger(fixture, held, (summary) => summary.terminal !== null, 30_000)
    const daemonIdentity = daemonHolder(fixture).identity
    const secondCall = await callBounded(app, action.path)
    const exited = await Promise.race([app.exit, sleep(30_000).then(() => null)])
    const daemonGone = daemonIdentity ? (await waitGone([daemonIdentity], 30_000)).length === 0 : false
    recordStep(scenario, { id: 'quit-without-run', actual: { call: secondCall, appExit: exited, daemonGone },
      pass: Boolean(exited) && daemonGone })

    const leftovers = fixtureLeftovers(fixture)
    const shellGone = terminal.ok ? (await waitGone([terminal.identity], 5_000)).length === 0 : null
    recordStep(scenario, { id: 'no-leftover-processes', actual: { processes: leftovers.processes, shellGone, owned: leftovers.owned },
      pass: leftovers.processes.status === 'available' && leftovers.processes.live.length === 0 && shellGone !== false })
    recordStep(scenario, { id: 'no-leftover-files', actual: leftovers.files, pass: leftovers.files.length === 0 })
  })
}
