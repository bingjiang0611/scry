#!/usr/bin/env node
// S0-3: the B4-V acceptance table, scripted, with the daemon switch on.
//
//   npm run build && node scripts/b4v-scenarios.mjs [--only close-app,reopen,...] [--out report.json]
//       [--no-controls] [--keep] [--restart-api <path>] [--quit-api <path>] [--old-daemon-entry <daemon.js>]
//
// Every scenario runs on its own fresh temporary userData / HOME / workspace under /tmp,
// asserts isolation before it acts (scry.db, daemon.lock and scry-userdata.lock in that
// temp userData, held by the process it launched), and records step-level evidence:
// expected, actual, pass / fail / not-run (with a reason). Where it is meaningful the
// same scenario runs with the switch off as a control. Nothing passes by default: a
// missing prerequisite or product hook is not-run, and a not-run step keeps the
// scenario (and the round) from passing.
//
// The report is JSON, written after every scenario. Exit code: 0 all pass, 2 any fail,
// 3 incomplete (not-run / partial / preflight). Runbook:
// docs/plans/remote-runtime-v2/status/b4-s0-scenarios.md
import { renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeAllApps } from './b4v/app.mjs'
import { stopFixtureDaemon } from './b4v/fixture.mjs'
import { gitState, preflightChecks } from './b4v/preflight.mjs'
import { createReport, finalizeReport, summaryLines } from './b4v/report.mjs'
import * as closeApp from './b4v/scenarios/close-app.mjs'
import * as mutualExclusion from './b4v/scenarios/mutual-exclusion.mjs'
import * as quitAll from './b4v/scenarios/quit-all.mjs'
import * as rendererIsolation from './b4v/scenarios/renderer-isolation.mjs'
import * as reopen from './b4v/scenarios/reopen.mjs'
import * as sigkill from './b4v/scenarios/sigkill.mjs'
import * as trustGate from './b4v/scenarios/trust-gate.mjs'
import * as upgrade from './b4v/scenarios/upgrade.mjs'

// B4-V table order. Controls live inside their scenario module.
export const SCENARIOS = Object.freeze({
  'close-app': closeApp.run,
  reopen: reopen.run,
  sigkill: sigkill.run,
  upgrade: upgrade.run,
  'quit-all': quitAll.run,
  'mutual-exclusion': mutualExclusion.run,
  'trust-gate': trustGate.run,
  'renderer-isolation': rendererIsolation.run
})

export function parseArgs(argv) {
  const options = { only: null, out: null, keep: false, noControls: false, restartApi: null, quitApi: null, oldDaemonEntry: null }
  const value = (index, name) => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`)
    return next
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--only') { options.only = value(index, arg).split(',').map((item) => item.trim()).filter(Boolean); index++ }
    else if (arg === '--out') { options.out = value(index, arg); index++ }
    else if (arg === '--restart-api') { options.restartApi = value(index, arg); index++ }
    else if (arg === '--quit-api') { options.quitApi = value(index, arg); index++ }
    else if (arg === '--old-daemon-entry') { options.oldDaemonEntry = value(index, arg); index++ }
    else if (arg === '--keep') options.keep = true
    else if (arg === '--no-controls') options.noControls = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  const unknown = (options.only ?? []).filter((name) => !SCENARIOS[name])
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}; known: ${Object.keys(SCENARIOS).join(', ')}`)
  return options
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const options = parseArgs(process.argv.slice(2))
  const out = resolve(options.out ?? join('/tmp', `scry-b4v-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
  const git = gitState(root)
  const report = createReport({ commit: git, options: { ...options, out } })
  const save = () => {
    const temporary = `${out}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
    renameSync(temporary, out)
  }
  report.preflight = preflightChecks(root, { git })
  const blocking = report.preflight.filter((check) => check.ok !== true && check.required !== false)
  const ctx = {
    root, options, report, save, active: new Set(),
    blocked: blocking.length > 0 ? `preflight failed: ${blocking.map((check) => check.id).join(', ')}` : null
  }
  save()

  let interrupted = false
  const interrupt = async (signal) => {
    if (interrupted) return
    interrupted = true
    process.stderr.write(`[b4v] ${signal}: stopping this run's Apps and daemons\n`)
    for (const fixture of ctx.active) {
      await closeAllApps(fixture).catch(() => undefined)
      await stopFixtureDaemon(fixture).catch(() => undefined)
    }
    finalizeReport(report)
    report.interrupted = signal
    save()
    process.exit(130)
  }
  process.on('SIGINT', () => { void interrupt('SIGINT') })
  process.on('SIGTERM', () => { void interrupt('SIGTERM') })

  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (options.only && !options.only.includes(name)) continue
    process.stderr.write(`[b4v] ${name}\n`)
    await run(ctx)
  }
  const summary = finalizeReport(report)
  save()
  for (const line of summaryLines(report)) process.stderr.write(`[b4v] ${line}\n`)
  process.stdout.write(`${JSON.stringify({ overall: summary.overall, scenarios: summary.scenarios, steps: summary.steps, report: out })}\n`)
  process.exit(summary.exitCode)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[b4v] runner error: ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}
