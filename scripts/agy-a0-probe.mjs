#!/usr/bin/env node
// Reusable Antigravity CLI (`agy acp`) A0 real-machine probe CLI (P7 / W7).
// Usage:
//   node scripts/agy-a0-probe.mjs --suite proto|auth|modes|paths|mcp|lifecycle|cancel|usage|subagent|launchd|zh [--out <file>]
import { writeFileSync } from 'node:fs'
import { createTempTracker, resolveAgyBin, scrubSecrets } from './agy-a0-probe/acp-harness.mjs'
import { runAuth, runModes, runPaths, runProto } from './agy-a0-probe/suites-policy.mjs'
import { runCancel, runLaunchd, runLifecycle, runMcp, runSubagent, runUsage, runZh } from './agy-a0-probe/suites-runtime.mjs'

const args = process.argv.slice(2)
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const suite = argVal('--suite') ?? 'proto'
const outFile = argVal('--out')
const agyBin = resolveAgyBin(argVal('--bin'))
const temps = createTempTracker()

const suites = {
  proto: runProto,
  auth: runAuth,
  modes: runModes,
  paths: runPaths,
  mcp: runMcp,
  lifecycle: runLifecycle,
  cancel: runCancel,
  usage: runUsage,
  subagent: runSubagent,
  launchd: runLaunchd,
  zh: runZh
}

try {
  if (!suites[suite]) throw new Error(`unknown_suite:${suite}`)
  const payload = scrubSecrets(await suites[suite]({ agyBin, temps }))
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (outFile) writeFileSync(outFile, text, 'utf8')
  process.stdout.write(text)
} finally {
  temps.cleanup()
}
