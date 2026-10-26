import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proposeTightening } from './performance-ratchet.mjs'
import { readLedger, writeLedger } from './performance-ledger.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function parseProposeArgs(argv) {
  let observations
  let write = false
  for (const argument of argv) {
    if (argument === '--write') write = true
    else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`)
    else if (!observations) observations = argument
    else throw new Error('Only one observations file may be provided')
  }
  if (!observations) throw new Error('Usage: performance:propose -- <observations.json> [--write]')
  return { observations, write }
}

export function makeProposal(observationsPath, { write = false, ledgerPath = join(root, 'scripts/performance-ratchet.json') } = {}) {
  const proposal = proposeTightening(readLedger(ledgerPath), readJson(observationsPath))
  if (write) writeLedger(ledgerPath, proposal.ledger)
  return proposal
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { observations, write } = parseProposeArgs(process.argv.slice(2))
    const proposal = makeProposal(resolve(observations), { write })
    console.log(JSON.stringify({ revision: proposal.revision, changes: proposal.changes, ledger: proposal.ledger }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
