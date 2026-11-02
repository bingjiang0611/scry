// Acceptance checks for one 50k main-only trial report (measurement only).
//
// Kept out of the launcher so the launcher stays about spawning, ownership and one stop. Every check below is
// a requirement of the measurement itself: a measured status needs complete step facts, timing and real
// process runtime evidence, a negative-control run must carry a rejected control record, and a failed run must
// keep its original failure text. Nothing here fabricates missing evidence.
import { readFileSync, statSync } from 'node:fs'
import { FIXED_ITEMS } from './concurrency-trace-main-artifact.mjs'

const RESULT_BYTES_LIMIT = 2 * 1024 * 1024

// The fixed stage contract, mirroring WORKLOAD_STEPS and stageItemCounts(50000) in
// scripts/fixtures/concurrency-trace-main-trial.ts. A focused test asserts both literals against those sources,
// so a shortened or reordered sample cannot pass this launcher.
export const EXPECTED_STEPS = ['seed', 'quiet', 'replace-stream', 'append', 'coalesce', 'backfill', 'done']
export const EXPECTED_STAGE_COUNTS = [50000, 50000, 49998, 50000, 50000, 50000, 50000]
const EXPECTED_OBSERVES = EXPECTED_STEPS.length
const EXPECTED_MERGES = EXPECTED_STEPS.length
const PHASE_NAMES = ['writer', 'reader', 'serialize', 'merge', 'oracle']
const isText = (value) => typeof value === 'string' && value.length > 0
const isCount = (value, expected) => typeof value === 'number' && value === expected
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function checkFacts(payload) {
  const facts = payload.facts
  if (!facts || typeof facts !== 'object') throw new Error('a measured report must carry step facts')
  if (facts.oracle !== 'checked') throw new Error('a measured report must state that the oracle was checked')
  if (!isCount(facts.observes, EXPECTED_OBSERVES)) throw new Error(`the trial reported ${JSON.stringify(facts.observes)} observes, not ${EXPECTED_OBSERVES}`)
  if (!isCount(facts.merges, EXPECTED_MERGES)) throw new Error(`the trial reported ${JSON.stringify(facts.merges)} merges, not ${EXPECTED_MERGES}`)
  if (!Array.isArray(facts.steps) || facts.steps.length !== EXPECTED_STEPS.length) {
    throw new Error(`the trial reported ${Array.isArray(facts.steps) ? facts.steps.length : 'no'} steps, not ${EXPECTED_STEPS.length}`)
  }
  facts.steps.forEach((step, index) => {
    if (!step || step.step !== EXPECTED_STEPS[index]) throw new Error(`step ${index} is ${JSON.stringify(step?.step)}, not ${EXPECTED_STEPS[index]}`)
    if (!isCount(step.itemCount, EXPECTED_STAGE_COUNTS[index])) throw new Error(`step ${step.step} delivered ${JSON.stringify(step.itemCount)} items, not ${EXPECTED_STAGE_COUNTS[index]}`)
    if (!isCount(step.cursorCount, step.itemCount)) throw new Error(`step ${step.step} cursor count disagrees with its items`)
    if (step.reply !== 'snapshot' && step.reply !== 'delta') throw new Error(`step ${step.step} has an unknown reply ${JSON.stringify(step.reply)}`)
  })
}

function checkTiming(payload) {
  for (const field of ['overall', 'phaseSum']) {
    const value = payload[field]
    if (!value || !isNumber(value.wallMs) || !isNumber(value.cpuUserUs) || !isNumber(value.cpuSystemUs)) throw new Error(`the report has no usable ${field} timing`)
  }
  if (!isNumber(payload.unobservedMs)) throw new Error('the report has no usable unobservedMs')
  if (!Array.isArray(payload.phases) || payload.phases.length === 0) throw new Error('the report has no phase records')
  if (payload.phases.length > EXPECTED_STEPS.length * PHASE_NAMES.length) throw new Error('the report has more phase records than one sample can produce')
  for (const sample of payload.phases) {
    if (!EXPECTED_STEPS.includes(sample?.step) || !PHASE_NAMES.includes(sample?.phase)) throw new Error('a phase record names an unknown step or phase')
    if (!isNumber(sample.wallMs) || !isNumber(sample.cpuUserUs) || !isNumber(sample.cpuSystemUs)) throw new Error('a phase record has no usable timing')
  }
  const memory = payload.memory
  if (!memory || !memory.before || !memory.after || !isText(memory.scope)) throw new Error('the report has no before/after memory snapshots')
}

/** Strict report check: a measured status is only accepted with complete step, timing and runtime evidence. */
export function readReport(path) {
  const bytes = statSync(path).size
  if (bytes > RESULT_BYTES_LIMIT) throw new Error(`the trial report is ${bytes} bytes, above the launcher bound`)
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  if (!payload || payload.schema !== 1) throw new Error('the trial report carries no schema 1 marker')
  if (payload.status !== 'measured' && payload.status !== 'failed') throw new Error(`the trial report has an unknown status ${JSON.stringify(payload.status)}`)
  if (!isCount(payload.k, FIXED_ITEMS)) throw new Error(`the trial ran k=${JSON.stringify(payload.k)}, not ${FIXED_ITEMS}`)
  const runtime = payload.runtime
  if (!runtime || !isNumber(runtime.pid) || runtime.pid <= 0) throw new Error('the report carries no real process id')
  for (const field of ['electron', 'node', 'v8', 'chrome', 'platform', 'arch']) {
    if (!isText(runtime[field])) throw new Error(`the report carries no ${field} runtime fact`)
  }
  if (payload.controlRequested !== null && payload.controlRequested !== 'corrupt-body') throw new Error(`the report names an unknown control ${JSON.stringify(payload.controlRequested)}`)
  const applied = payload.controlApplied
  if (applied !== null && (applied.kind !== 'corrupt-body' || applied.rejected !== true || !isText(applied.oracleError) || !EXPECTED_STEPS.includes(applied.step))) {
    throw new Error('the report claims a control result without a rejected corrupt-body record')
  }
  if (!Array.isArray(payload.windowFaults)) throw new Error('the report does not state its window faults')
  if (payload.status === 'measured') {
    if (payload.failure !== null) throw new Error('a measured report must not carry a failure')
    if (payload.controlRequested !== null) throw new Error('a negative-control run can never be measured')
    if (payload.windowFaults.length > 0) throw new Error('a measured report must not carry window faults')
    checkFacts(payload)
    checkTiming(payload)
  } else {
    if (!payload.failure || !isText(payload.failure.error)) throw new Error('a failed report must carry the original failure text')
    if (payload.controlRequested === 'corrupt-body' && applied === null) throw new Error('the requested control was never applied, so this run proves nothing')
  }
  return payload
}
