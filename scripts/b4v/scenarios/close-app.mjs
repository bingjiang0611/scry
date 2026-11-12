// B4-V「关闭 App 窗口和进程」: the run keeps going without the App and settles in the
// daemon; the daemon survives; (a remote device still sees it). Terminals follow the
// maintainer's 2026-11-11 decision (P3-terminal.md), which replaces B4-V's「终端继续」:
// shells never outlive the App, so a graceful quit ends them and a crash leaves them to
// the daemon's reclaim.
import { attempt, crashApp, quitApp } from '../app.mjs'
import { daemonHolder } from '../fixture.mjs'
import { Abort, PACED_PROMPT, openChecked, runScenario, startRun, startTerminal, stillAlive, waitLedger } from '../kit.mjs'
import { waitGone } from '../process-identity.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

// The App's quit asks the daemon to shut its terminals down (bounded at 3 s); a shell
// may then take a moment to exit. Past this, the shell outlived the App: a failure.
export const TERMINAL_QUIT_GONE_MS = 10_000

export const plan = [
  { id: 'terminal-started', expected: 'a terminal starts in the workspace before the App closes (pty identity recorded)' },
  { id: 'run-dispatched', expected: 'the paced run is run_dispatched in the daemon ledger, and not yet terminal, before the App closes' },
  { id: 'app-quit', expected: 'SIGTERM (Electron app.quit, same cleanup as Cmd+Q) ends the App main within 20 s, its renderer/GPU children with it' },
  { id: 'daemon-survives-quit', expected: 'after the quit, daemon.lock still names the same verified daemon process' },
  { id: 'run-settles-after-quit', expected: 'the daemon ledger records run_settled for the run, timestamped after the App exited' },
  { id: 'terminal-after-quit', expected: 'P3-terminal (2026-11-11): the terminal process started before the graceful quit is gone within 10 s after it (shells do not outlive the App)' },
  { id: 'new-app-reads-settled', expected: 'a new App attaches to the same daemon and lists no active run (the run is settled)' },
  { id: 'run-settles-after-crash', expected: 'App SIGKILL during a paced run: the ledger records run_settled after the kill' },
  { id: 'terminal-after-crash', expected: 'App SIGKILL: the terminal process is alive right after the crash (before the ~90 s reclaim)' },
  { id: 'remote-device-visibility', expected: 'a paired remote device still connects and sees the run trace after the App closes' }
]

async function pacedDispatched(fixture, app, scenario, stepId) {
  const paced = await startRun(app, { prompt: PACED_PROMPT, cwd: fixture.workspace })
  if (!paced.ok) throw new Abort(`paced start refused: ${paced.error}`)
  const dispatched = await waitLedger(fixture, paced, (summary) => summary.dispatches >= 1, 15_000)
  if (stepId) {
    recordStep(scenario, { id: stepId, actual: dispatched.summary, evidence: { ledger: dispatched.path },
      pass: dispatched.ok && dispatched.summary.terminal === null })
    if (!dispatched.ok) throw new Abort('the paced run never reached run_dispatched')
  }
  return { paced, dispatched }
}

function recordSettledAfter(scenario, id, settled, endedAt, what) {
  const summary = settled.summary
  if (summary?.terminal === 'settled' && summary.terminalAt !== null && endedAt !== null && summary.terminalAt <= endedAt) {
    recordNotRun(scenario, { id, reason: `the run settled ${endedAt - summary.terminalAt} ms before ${what}; continuation without the App was not exercised (machine too slow or quit too slow)`,
      evidence: { summary, endedAt } })
    return
  }
  recordStep(scenario, { id, actual: { ...summary, endedAt }, evidence: { ledger: settled.path },
    pass: settled.ok && summary.terminal === 'settled' && endedAt !== null && summary.terminalAt > endedAt })
}

export async function run(ctx) {
  return runScenario(ctx, { id: 'close-app', title: '关闭 App 窗口和进程', mode: 'daemon', label: 'close', plan }, async ({ scenario, fixture }) => {
    const first = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-1' })
    const before = daemonHolder(fixture)
    scenario.evidence.daemonBefore = { pid: before.lock?.pid, startedBy: before.lock?.startedBy }

    const terminal = await startTerminal(first, fixture, 'b4v-close-quit')
    recordStep(scenario, { id: 'terminal-started', actual: terminal, pass: terminal.ok === true })

    const { paced } = await pacedDispatched(fixture, first, scenario, 'run-dispatched')
    const quit = await quitApp(first, fixture)
    recordStep(scenario, { id: 'app-quit', actual: quit, pass: quit.graceful === true && quit.remaining.length === 0 })

    const after = daemonHolder(fixture)
    recordStep(scenario, { id: 'daemon-survives-quit', actual: { verdict: after.verdict, pid: after.lock?.pid ?? null },
      pass: after.verdict === 'verified' && after.lock.identityKey === before.lock?.identityKey })

    const settled = await waitLedger(fixture, paced, (summary) => summary.terminal !== null, 30_000)
    recordSettledAfter(scenario, 'run-settles-after-quit', settled, quit.exitedAt, 'the App exited')

    if (terminal.ok) {
      const live = await waitGone([terminal.identity], TERMINAL_QUIT_GONE_MS)
      recordStep(scenario, { id: 'terminal-after-quit', actual: { pid: terminal.pid, stillAlive: live.length > 0, waitedUpToMs: TERMINAL_QUIT_GONE_MS },
        pass: live.length === 0 })
    } else {
      recordNotRun(scenario, { id: 'terminal-after-quit', reason: `no terminal was started: ${terminal.error}` })
    }

    const second = await openChecked(ctx, scenario, fixture, { mode: 'daemon', label: 'app-2', isolation: false })
    const listed = await attempt(second, 'window.scry.activeRuns().then((runs) => runs.map((run) => ({ runId: run.runId, done: run.done })))')
    const sameDaemon = daemonHolder(fixture)
    recordStep(scenario, { id: 'new-app-reads-settled', actual: { activeRuns: listed, daemonPid: sameDaemon.lock?.pid ?? null },
      pass: listed.ok && listed.value.length === 0 && sameDaemon.verdict === 'verified' && sameDaemon.lock.identityKey === before.lock?.identityKey })

    const crashTerminal = await startTerminal(second, fixture, 'b4v-close-crash')
    const { paced: crashPaced } = await pacedDispatched(fixture, second, scenario)
    const crash = await crashApp(second, fixture)
    scenario.evidence.crash = crash
    const crashAlive = crashTerminal.ok ? stillAlive(crashTerminal.identity) : null
    const crashSettled = await waitLedger(fixture, crashPaced, (summary) => summary.terminal !== null, 30_000)
    recordSettledAfter(scenario, 'run-settles-after-crash', crashSettled, crash.killedAt, 'the App was killed')
    if (crashTerminal.ok) {
      recordStep(scenario, { id: 'terminal-after-crash', actual: { pid: crashTerminal.pid, alive: crashAlive }, pass: crashAlive === true })
    } else {
      recordNotRun(scenario, { id: 'terminal-after-crash', reason: `no terminal was started: ${crashTerminal.error}` })
    }

    recordNotRun(scenario, { id: 'remote-device-visibility',
      reason: 'no paired-device fixture against a daemon-mode host exists in this harness (desktop-remote-host-smoke pairs with the in-process host); run it manually with a real paired phone/desktop' })
  })
}
