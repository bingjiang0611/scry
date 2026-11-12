const SIDES = new Set(['baseline', 'candidate'])
export const ABAB_BATCHES = 20
export const MAX_DIAGNOSTIC_STAGES = 256

export function sideBatchId(side, index) {
  if (!SIDES.has(side)) throw new Error(`Unknown ABAB side: ${side}`)
  if (!Number.isInteger(index) || index < 1) throw new Error(`Invalid ABAB batch index: ${index}`)
  return `${side === 'baseline' ? 'A' : 'B'}${index}`
}

export function batchPlan(scenarios, batches = ABAB_BATCHES) {
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.some(scenario => typeof scenario !== 'string' || !scenario)) throw new Error('ABAB scenarios must be a non-empty list of names')
  if (batches !== ABAB_BATCHES) throw new Error(`ABAB batch count must be ${ABAB_BATCHES}`)
  return scenarios.flatMap(scenario => Array.from({ length: batches }, (_, offset) => ({
    scenario, index: offset + 1,
    requests: [{ side: 'baseline', batchId: sideBatchId('baseline', offset + 1) }, { side: 'candidate', batchId: sideBatchId('candidate', offset + 1) }]
  })))
}

export function validateBatchSamples(results, scenarios, batches = ABAB_BATCHES) {
  if (!results || typeof results !== 'object') throw new Error('ABAB results are missing')
  for (const scenario of scenarios) {
    const result = results[scenario]
    if (!result || result.outcome !== 'completed') throw new Error(`ABAB scenario did not complete: ${scenario}`)
    if (!Array.isArray(result.durationMs) || result.durationMs.length !== batches) throw new Error(`ABAB sample count is not ${batches}: ${scenario}`)
    if (!result.durationMs.every(value => Number.isFinite(value) && value >= 0)) throw new Error(`ABAB samples are invalid: ${scenario}`)
  }
}

export function stageKind(moduleName, operation) {
  if (moduleName === 'git' || operation === 'git') return 'git-command'
  if (moduleName === 'fs/promises' || operation === 'file') return 'file-operation'
  return 'process-command'
}

export function recordDiagnosticStage(context, kind, operation, startedAtMs, endedAtMs) {
  const durationMs = Math.max(0, endedAtMs - startedAtMs)
  const total = context.stageTotals[kind] ??= { count: 0, totalMs: 0, maxMs: 0 }
  total.count++
  total.totalMs += durationMs
  total.maxMs = Math.max(total.maxMs, durationMs)
  if (context.stages.length >= MAX_DIAGNOSTIC_STAGES) {
    context.droppedStageCount++
    return
  }
  context.stages.push({ side: context.side, scenario: context.scenario, batchId: context.batchId,
    kind, operation, durationMs, startedAtMs, endedAtMs, provenance: 'vitest-mock-real-call' })
}

export function validateStageTotals(batch) {
  const totals = Object.entries(batch.stageTotals)
  const validKinds = ['git-command', 'file-operation', 'process-command']
  if (totals.some(([kind, value]) => !validKinds.includes(kind) || !Number.isSafeInteger(value.count) || value.count < 0 ||
    !Number.isFinite(value.totalMs) || value.totalMs < 0 || !Number.isFinite(value.maxMs) || value.maxMs < 0 || value.maxMs > value.totalMs)) throw new Error('Invalid ABAB stage totals')
  if (!Number.isSafeInteger(batch.droppedStageCount) || batch.droppedStageCount < 0 || batch.stages.length > MAX_DIAGNOSTIC_STAGES ||
    totals.reduce((sum, [, value]) => sum + value.count, 0) !== batch.stages.length + batch.droppedStageCount) throw new Error('Incomplete ABAB stage accounting')
}

export function parseAbabArgs(argv) {
  const options = { baseline: null, candidate: null, output: null, batches: ABAB_BATCHES, sameSource: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`)
      return next
    }
    if (argument === '--baseline') options.baseline = value()
    else if (argument === '--candidate') options.candidate = value()
    else if (argument === '--output') options.output = value()
    else if (argument === '--batches') options.batches = Number(value())
    else if (argument === '--same-source') options.sameSource = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!options.candidate || !options.output) throw new Error('Usage: performance-abab.mjs --candidate <dir> --output <dir> [--baseline <dir>] [--same-source]')
  if (!options.sameSource && !options.baseline) throw new Error('--baseline is required unless --same-source is set')
  if (options.sameSource) options.baseline = options.candidate
  if (options.batches !== ABAB_BATCHES) throw new Error(`--batches must be ${ABAB_BATCHES}`)
  return options
}

export function protocolLine(message) { return `${JSON.stringify(message)}\n` }
export function parseProtocolLine(line) {
  const message = JSON.parse(line)
  if (!message || typeof message !== 'object' || typeof message.id !== 'number') throw new Error('Invalid ABAB protocol message')
  return message
}
