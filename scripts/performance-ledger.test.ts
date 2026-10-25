import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLedger, writeLedger } from './performance-ledger.mjs'
import { checkLedgerChange, checkRatchet, validateLedger } from './performance-ratchet.mjs'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scry-ledger-'))
  mkdirSync(join(directory, 'domains'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const metric = {
  scenario: 'history.page', metric: 'ipc.messages', layer: 'ipc', unit: 'count',
  workload: 'history-turns=4000;page=40', source: 'fixed page fixture',
  status: 'gating', ceiling: 2, tolerance: 0,
  evidence: { stability: 'five repeats', sensitivity: 'duplicate message', correlation: 'fixed page latency' }
}
const flat = { schema: 1, metrics: { 'history.page/ipc.messages': metric } }
const manifest = { schema: 1, includes: ['domains/history.json'], metrics: {} }
const writeJson = (file: string, value: unknown) => writeFileSync(join(directory, file), `${JSON.stringify(value, null, 2)}\n`)

function writeModular() {
  writeJson('ledger.json', manifest)
  writeJson('domains/history.json', flat)
  return join(directory, 'ledger.json')
}

describe('domain performance ledgers', () => {
  it('loads the same metrics from legacy and modular layouts without changing gates', () => {
    writeJson('legacy.json', flat)
    const path = writeModular()
    expect(readLedger(path)).toEqual(readLedger(join(directory, 'legacy.json')))
    expect(checkLedgerChange(flat, readLedger(path))).toEqual({ passed: true, violations: [] })
    const result = checkRatchet(readLedger(path), {
      schema: 1, revision: 'candidate', observations: [{
        ...metric, availability: 'measured', runs: [3, 3]
      }]
    })
    expect(result.passed).toBe(false)
    expect(result.rows[0].result).toBe('regressed')
  })

  it('writes tightened metrics to their owning domain and preserves the manifest', () => {
    const path = writeModular()
    const before = readFileSync(path, 'utf8')
    const next = structuredClone(flat)
    next.metrics['history.page/ipc.messages'].ceiling = 1
    writeLedger(path, next)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readLedger(path)).toEqual(next)
    expect(JSON.parse(readFileSync(join(directory, 'domains/history.json'), 'utf8'))).toEqual(next)
  })

  it('continues to update a legacy single-file ledger', () => {
    const path = join(directory, 'legacy.json')
    writeJson('legacy.json', flat)
    const next = structuredClone(flat)
    next.metrics['history.page/ipc.messages'].ceiling = 1
    writeLedger(path, next)
    expect(readLedger(path)).toEqual(next)
  })

  it('rejects a raw manifest instead of silently checking zero metrics', () => {
    expect(() => validateLedger(manifest)).toThrow('readLedger')
  })

  it('rejects duplicate metrics, missing domains and nested includes', () => {
    const path = writeModular()
    writeJson('ledger.json', { ...manifest, metrics: flat.metrics })
    expect(() => readLedger(path)).toThrow('Duplicate ledger metric')
    writeJson('ledger.json', manifest)
    writeJson('domains/history.json', { ...flat, includes: [] })
    expect(() => readLedger(path)).toThrow('without nested includes')
    rmSync(join(directory, 'domains/history.json'))
    expect(() => readLedger(path)).toThrow()
  })

  it('rejects schema mismatch and invalid domain declarations', () => {
    const path = writeModular()
    writeJson('domains/history.json', { ...flat, schema: 2 })
    expect(() => readLedger(path)).toThrow('root schema')
    writeJson('ledger.json', { ...manifest, includes: 'domains/history.json' })
    expect(() => readLedger(path)).toThrow('includes must list')
  })

  it('cannot silently discard a new or removed metric during writeback', () => {
    const path = writeModular()
    expect(() => writeLedger(path, { schema: 1, metrics: {} })).toThrow('Register metric keys')
    expect(() => writeLedger(path, { schema: 1, metrics: { ...flat.metrics, 'extra/key': metric } })).toThrow('Register metric keys')
    expect(readLedger(path)).toEqual(flat)
  })
})
