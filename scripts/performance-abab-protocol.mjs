const SIDES = new Set(['baseline', 'candidate'])
const MAX_DIAGNOSTIC_STAGES = 256

export const ABAB_BATCHES = 20
export const ABAB_ROUNDS = 3

export function sideBatchId(side, index) {
  if (!SIDES.has(side)) throw new Error(`Unknown ABAB side: ${side}`)
  if (!Number.isInteger(index) || index < 1) throw new Error(`Invalid ABAB batch index: ${index}`)
  return `${side === 'baseline' ? 'A' : 'B'}${index}`
}

export function batchPlan(scenarios, batches = ABAB_BATCHES) {
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.some(scenario => typeof scenario !== 'string' || !scenario)) {
    throw new Error('ABAB scenarios must be a non-empty list of names')
  }
  if (!Number.isInteger(batches) || batches < ABAB_BATCHES) throw new Error(`ABAB batch count must be at least ${ABAB_BATCHES}`)
  return scenarios.flatMap(scenario => Array.from({ length: batches }, (_, offset) => ({
    scenario,
    index: offset + 1,
    requests: [
      { side: 'baseline', batchId: sideBatchId('baseline', offset + 1) },
      { side: 'candidate', batchId: sideBatchId('candidate', offset + 1) }
    ]
  })))
}

export function validateBatchSamples(results, scenarios, batches = ABAB_BATCHES) {
  if (!results || typeof results !== 'object') throw new Error('ABAB results are missing')
  for (const scenario of scenarios) {
    const result = results[scenario]
    if (!result || result.outcome !== 'completed') throw new Error(`ABAB scenario did not complete: ${scenario}`)
    if (!Array.isArray(result.durationMs) || result.durationMs.length !== batches) {
      throw new Error(`ABAB sample count is not ${batches}: ${scenario}`)
    }
    if (!result.durationMs.every(value => Number.isFinite(value) && value >= 0)) throw new Error(`ABAB samples are invalid: ${scenario}`)
  }
}

export function boundedStages(stages, limit = MAX_DIAGNOSTIC_STAGES) {
  if (!Array.isArray(stages) || !Number.isInteger(limit) || limit < 1) return []
  return stages.length <= limit ? stages : stages.slice(0, limit)
}

export function stageKind(moduleName, operation) {
  if (moduleName === 'git' || operation === 'git') return 'git-command'
  if (moduleName === 'fs/promises' || operation === 'file') return 'file-operation'
  return 'benchmark-operation'
}

export function parseAbabArgs(argv) {
  const options = { baseline: null, candidate: null, output: null, rounds: ABAB_ROUNDS, batches: ABAB_BATCHES, sameSource: false }
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
    else if (argument === '--rounds') options.rounds = Number(value())
    else if (argument === '--batches') options.batches = Number(value())
    else if (argument === '--same-source') options.sameSource = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!options.candidate || !options.output) throw new Error('Usage: performance-abab.mjs --candidate <dir> --output <dir> [--baseline <dir>] [--same-source]')
  if (!options.sameSource && !options.baseline) throw new Error('--baseline is required unless --same-source is set')
  if (options.sameSource) options.baseline = options.candidate
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error('--rounds must be a positive integer')
  if (!Number.isInteger(options.batches) || options.batches < 20) throw new Error('--batches must be at least 20')
  return options
}

export function protocolLine(message) {
  return `${JSON.stringify(message)}\n`
}

export function parseProtocolLine(line) {
  const message = JSON.parse(line)
  if (!message || typeof message !== 'object' || typeof message.id !== 'number') throw new Error('Invalid ABAB protocol message')
  return message
}

export { MAX_DIAGNOSTIC_STAGES }
