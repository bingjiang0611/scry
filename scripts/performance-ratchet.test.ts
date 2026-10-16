import { describe, expect, it } from 'vitest'
import { checkLedgerChange, checkRatchet, proposeTightening, validateLedger } from './performance-ratchet.mjs'
import ledgerFile from './performance-ratchet.json'

const gating = (ceiling: number, extra: Record<string, unknown> = {}) => ({
  scenario: 'history.page', metric: 'ipc.messages', layer: 'ipc', unit: 'count', workload: 'history-turns=4000;page=40',
  source: 'fixture IPC sender wrapper', status: 'gating', ceiling, tolerance: 0,
  evidence: { stability: '5/5 identical', sensitivity: 'duplicate send +1', correlation: 'fewer messages, lower p95' }, ...extra
})
const ledger = (entry: object) => ({ schema: 1, metrics: { 'history.page/ipc.messages': entry } })
const observed = (runs: number[] | null, extra: Record<string, unknown> = {}, platform?: string) => ({
  schema: 1, revision: 'candidate', ...(platform ? { platform } : {}), observations: [{
    scenario: 'history.page', metric: 'ipc.messages', layer: 'ipc', unit: 'count', workload: 'history-turns=4000;page=40', source: 'fixture IPC sender wrapper',
    ...(runs ? { availability: 'measured', runs } : { availability: 'unavailable', reason: 'collector not supported on this runner' }), ...extra
  }]
})
const resultOf = (entry: object, runs: number[] | null) => checkRatchet(ledger(entry), observed(runs)).rows[0]

describe('work-counter ratchet', () => {
  it('keeps the committed ledger valid', () => {
    expect(() => validateLedger(ledgerFile)).not.toThrow()
  })

  it('fails a gating counter that does more work than its ceiling', () => {
    expect(resultOf(gating(3), [4, 4])).toMatchObject({ result: 'regressed', gateFailed: true })
    expect(checkRatchet(ledger(gating(3)), observed([4])).passed).toBe(false)
  })

  it('allows reviewed tolerance but proposes tightening when work drops', () => {
    expect(resultOf(gating(3, { tolerance: 1 }), [4, 4])).toMatchObject({ result: 'pass' })
    expect(resultOf(gating(3), [2, 2])).toMatchObject({ result: 'tightenable', proposedCeiling: 2, gateFailed: false })
  })

  it('fails closed when repeated same-revision runs disagree or evidence is unavailable', () => {
    expect(resultOf(gating(5), [2, 3])).toMatchObject({ result: 'unstable', gateFailed: true })
    expect(resultOf(gating(5), null)).toMatchObject({ result: 'unavailable', gateFailed: true })
    expect(checkRatchet(ledger(gating(5)), { schema: 1, revision: 'candidate', observations: [] }).rows[0]).toMatchObject({ result: 'missing', gateFailed: true })
  })

  it('reports candidates without gating and rejects unavailable values disguised as zero', () => {
    const candidate = { ...gating(0), status: 'candidate', ceiling: null, evidence: undefined }
    expect(resultOf(candidate, [99])).toMatchObject({ result: 'candidate', gateFailed: false })
    expect(() => checkRatchet(ledger(candidate), observed(null, { runs: [0] }))).toThrow(/Unavailable observation/)
  })

  it('flags candidates worse than the same-platform baseline without failing the gate', () => {
    const candidate = { ...gating(0), status: 'candidate', ceiling: null, evidence: undefined, tolerance: 1, baselines: { 'darwin-arm64': 10 } }
    const check = (runs: number[], platform?: string) => checkRatchet(ledger(candidate), observed(runs, {}, platform)).rows[0]
    expect(check([12], 'darwin-arm64')).toMatchObject({ result: 'worse', baseline: 10, gateFailed: false })
    expect(check([11], 'darwin-arm64')).toMatchObject({ result: 'unchanged', baseline: 10 })
    expect(check([9], 'darwin-arm64')).toMatchObject({ result: 'better', baseline: 10 })
    // Another OS may legitimately count differently; no cross-platform verdict is invented.
    expect(check([50], 'linux-x64')).toMatchObject({ result: 'candidate' })
    expect(check([50])).toMatchObject({ result: 'candidate' })
    expect(checkRatchet(ledger(candidate), observed([12], {}, 'darwin-arm64')).passed).toBe(true)
    expect(() => validateLedger(ledger({ ...candidate, baselines: { 'darwin-arm64': -1 } }))).toThrow(/Baselines/)
  })

  it('records missing baselines and only lowers existing ones when proposing', () => {
    const candidate = { ...gating(0), status: 'candidate', ceiling: null, evidence: undefined, baselines: { 'darwin-arm64': 10 } }
    const baselines = (runs: number[], platform: string) => proposeTightening(ledger(candidate), observed(runs, {}, platform)).ledger.metrics['history.page/ipc.messages'].baselines
    expect(baselines([8], 'darwin-arm64')).toEqual({ 'darwin-arm64': 8 })
    expect(baselines([12], 'darwin-arm64')).toEqual({ 'darwin-arm64': 10 })
    expect(baselines([30], 'linux-x64')).toEqual({ 'darwin-arm64': 10, 'linux-x64': 30 })
    expect(proposeTightening(ledger(candidate), observed([8])).changes).toEqual([])
    expect(checkLedgerChange(ledger(candidate), ledger({ ...candidate, baselines: { 'darwin-arm64': 9 } })).passed).toBe(true)
    expect(checkLedgerChange(ledger(candidate), ledger({ ...candidate, baselines: { 'darwin-arm64': 11 } })).violations).toEqual([expect.objectContaining({ kind: 'needs-approval' })])
    expect(checkLedgerChange(ledger(candidate), ledger({ ...candidate, baselines: {} })).passed).toBe(false)
    expect(checkLedgerChange(ledger(candidate), ledger({ ...candidate, baselines: { 'darwin-arm64': 11 } }), { raiseApproved: true }).passed).toBe(true)
  })

  it('refuses gating without the three promotion checks or with a changed workload', () => {
    expect(() => validateLedger(ledger(gating(3, { evidence: { stability: 'x', sensitivity: 'x' } })))).toThrow(/correlation/)
    expect(() => checkRatchet(ledger(gating(3)), observed([3], { workload: 'history-turns=40' }))).toThrow(/methodology/)
  })

  it('only lowers ceilings when proposing', () => {
    const proposal = proposeTightening(ledger(gating(5)), observed([3, 3]))
    expect(proposal.changes).toEqual([{ key: 'history.page/ipc.messages', from: 5, to: 3 }])
    expect(proposal.ledger.metrics['history.page/ipc.messages'].ceiling).toBe(3)
    expect(() => proposeTightening(ledger(gating(2)), observed([3]))).toThrow(/failing/)
  })

  it('treats tightening as free and every loosening as an approved change', () => {
    const base = ledger(gating(5))
    expect(checkLedgerChange(base, ledger(gating(4))).passed).toBe(true)
    const raise = ledger(gating(6, { raise: { from: 5, to: 6, reason: 'new attachment preview sends one more batch' } }))
    expect(checkLedgerChange(base, raise).violations).toEqual([expect.objectContaining({ kind: 'needs-approval' })])
    expect(checkLedgerChange(base, raise, { raiseApproved: true }).passed).toBe(true)
    expect(checkLedgerChange(base, ledger(gating(6)), { raiseApproved: true }).violations).toEqual([expect.objectContaining({ kind: 'raise-record' })])
    expect(checkLedgerChange(base, ledger(gating(5, { tolerance: 1 }))).passed).toBe(false)
    expect(checkLedgerChange(base, ledger({ ...gating(5), status: 'candidate', ceiling: null })).passed).toBe(false)
    expect(checkLedgerChange(base, { schema: 1, metrics: {} }).passed).toBe(false)
    expect(checkLedgerChange(base, ledger(gating(5, { workload: 'history-turns=40;page=40' })), { raiseApproved: true }).violations).toEqual([expect.objectContaining({ kind: 'redefined' })])
  })
})
