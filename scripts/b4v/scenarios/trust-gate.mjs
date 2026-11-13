// B4-V「trust gate」: the daemon re-verifies a repository's MCP configuration at the start
// boundary (canonical cwd + content/executable fingerprint) and refuses to run when that
// verification fails after the configuration changed.
//
// Policy (CLAUDE.md, maintainer 2026-09-21): repository MCP / Codex Hook / OpenCode plugin
// are auto-authorized; a changed fingerprint is re-verified, and only a failed
// verification refuses. B4-V's wording 「指纹变化拒绝执行」 is read under that policy:
//   1. a safe project MCP config: the run settles (auto-authorized);
//   2. changed to a config that cannot be executed safely (NODE_OPTIONS in the server env):
//      the start is refused and the refusal names the cause, without Provider output;
//   3. changed again to a different safe config: re-verified and allowed.
// The switch-off control runs the same three; the daemon must behave identically.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPLETE_PROMPT, openChecked, runScenario, startRun, waitLedger, waitRun } from '../kit.mjs'
import { classifyTrustStart } from '../outcomes.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

export const POLICY_NOTE = 'CLAUDE.md (2026-09-21): a changed fingerprint is re-verified and auto-authorized; only a failed verification refuses. B4-V says 「指纹变化拒绝执行」; this step follows CLAUDE.md.'

// Codex reads <cwd>/.codex/config.toml; /bin/echo is a regular, hashable executable on both platforms.
export const SAFE_CONFIG = '[mcp_servers.b4v_probe]\ncommand = "/bin/echo"\nargs = ["b4v"]\n'
export const UNSAFE_CONFIG = `${SAFE_CONFIG}\n[mcp_servers.b4v_probe.env]\nNODE_OPTIONS = "--require=/nonexistent/b4v-trust-probe.js"\n`
export const CHANGED_SAFE_CONFIG = '[mcp_servers.b4v_probe]\ncommand = "/bin/echo"\nargs = ["b4v", "changed"]\n'
export const UNSAFE_CAUSE = /NODE_OPTIONS/

const commonPlan = [
  { id: 'safe-config-settles', expected: 'with a safe repo MCP config (.codex/config.toml), a run settles without error' },
  { id: 'unsafe-change-refused', expected: 'after changing the config to one that fails verification (NODE_OPTIONS in env), the start is refused naming NODE_OPTIONS, with no Provider output' },
  { id: 'changed-safe-config-reverified', expected: 'after changing to a different safe config, the start is re-verified and settles (auto-authorization policy)' }
]
export const daemonPlan = [
  ...commonPlan,
  { id: 'refusal-recorded-as-failed', expected: 'the refused start never settles in the daemon ledger: no intent, or an intent that ended failed/cancelled (its dispatch count is recorded as evidence)' },
  { id: 'matches-in-process', expected: 'all three outcomes equal the switch-off control outcomes' }
]

function writeConfig(fixture, text) {
  mkdirSync(join(fixture.workspace, '.codex'), { recursive: true })
  writeFileSync(join(fixture.workspace, '.codex', 'config.toml'), text)
}

async function attemptStart(app, fixture, tag, expectCause) {
  const started = await startRun(app, { prompt: COMPLETE_PROMPT(tag), cwd: fixture.workspace })
  const run = started.ok ? (await waitRun(app, started.runId, (view) => view.done === true, 30_000)).value : null
  return { started, ...classifyTrustStart({ startError: started.ok ? null : started.error, run, expectCause }) }
}

async function exercise(ctx, scenario, fixture, mode) {
  writeConfig(fixture, SAFE_CONFIG)
  const app = await openChecked(ctx, scenario, fixture, { mode, label: 'app-1' })
  const outcomes = {}
  outcomes.safe = await attemptStart(app, fixture, 'trust-safe')
  recordStep(scenario, { id: 'safe-config-settles', actual: outcomes.safe, pass: outcomes.safe.outcome === 'settled' })

  writeConfig(fixture, UNSAFE_CONFIG)
  outcomes.unsafe = await attemptStart(app, fixture, 'trust-unsafe', UNSAFE_CAUSE)
  recordStep(scenario, { id: 'unsafe-change-refused', actual: outcomes.unsafe,
    pass: outcomes.unsafe.outcome === 'refused' && outcomes.unsafe.providerOutput === false })

  writeConfig(fixture, CHANGED_SAFE_CONFIG)
  outcomes.changed = await attemptStart(app, fixture, 'trust-changed')
  recordStep(scenario, { id: 'changed-safe-config-reverified', actual: outcomes.changed, pass: outcomes.changed.outcome === 'settled', note: POLICY_NOTE })

  if (mode === 'daemon') {
    const ledger = await waitLedger(fixture, outcomes.unsafe.started, (summary) => summary.terminal !== null, 5_000)
    const summary = ledger.summary
    recordStep(scenario, { id: 'refusal-recorded-as-failed', actual: summary ?? { intent: 'not recorded' }, evidence: { ledger: ledger.path },
      // "No intent" only counts when the ledger itself was readable.
      pass: summary ? ['failed', 'cancelled'].includes(summary.terminal) : ledger.ledgerStatus === 'available' })
  }
  return Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, value.outcome]))
}

export async function run(ctx) {
  let control = null
  if (!ctx.options.noControls) {
    await runScenario(ctx, { id: 'trust-gate-control', title: 'trust gate（开关关闭对照）', mode: 'switch-off', label: 'trust-off', plan: commonPlan },
      async ({ scenario, fixture }) => { control = await exercise(ctx, scenario, fixture, 'switch-off') })
  }
  return runScenario(ctx, { id: 'trust-gate', title: 'trust gate 在 daemon 内重验', mode: 'daemon', label: 'trust', plan: daemonPlan }, async ({ scenario, fixture }) => {
    const outcomes = await exercise(ctx, scenario, fixture, 'daemon')
    if (!control) {
      recordNotRun(scenario, { id: 'matches-in-process', reason: 'switch-off control did not complete (--no-controls or it aborted)' })
      return
    }
    recordStep(scenario, { id: 'matches-in-process', actual: { daemon: outcomes, control },
      pass: Object.keys(control).every((key) => control[key] === outcomes[key]) })
  })
}
