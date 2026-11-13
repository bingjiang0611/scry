import { describe, expect, it } from 'vitest'
import {
  failedHostRestarted, intentsForPrompt, mergeEvents, parseLedgerLog, readLedger, runIdForIntent, runIdForPrompt, runIdForScryRun, runSummary
} from './ledger.mjs'

const line = (event) => JSON.stringify(event)
const log = [
  line({ seq: 1, at: 10, runId: 'r1', kind: 'intent_recorded', intentId: 'i1', detail: JSON.stringify({ prompt: 'hold abc' }) }),
  line({ seq: 2, at: 11, runId: 'r1', kind: 'run_dispatched' }),
  line({ seq: 3, at: 20, runId: 'r1', kind: 'run_failed', detail: 'host_restarted: Mac 上的 Scry 在这轮结束前重启' }),
  line({ seq: 4, at: 21, runId: 'r2', kind: 'intent_recorded', intentId: 'i2', detail: JSON.stringify({ prompt: 'other' }) }),
  '{"torn',
  ''
].join('\n')

function fakeFs(files) {
  return { readFile: (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path] }, exists: (path) => path in files }
}

describe('b4v ledger reading', () => {
  it('parses events and counts torn lines instead of failing', () => {
    const parsed = parseLedgerLog(log)
    expect(parsed.events).toHaveLength(4)
    expect(parsed.torn).toBe(1)
  })

  it('summarizes one run: dispatch count, terminal state and host_restarted', () => {
    const ledger = readLedger('/u', fakeFs({ '/u/remote/ledger/session-ledger.log': log }))
    expect(ledger.status).toBe('available')
    const summary = runSummary(ledger, 'r1')
    expect(summary).toMatchObject({ dispatches: 1, dispatchCountExact: true, terminal: 'failed', terminalAt: 20, intentId: 'i1' })
    expect(failedHostRestarted(summary)).toBe(true)
    expect(failedHostRestarted(runSummary(ledger, 'r2'))).toBe(false)
  })

  it('a second dispatch of the same run is visible in the count', () => {
    const twice = `${log}${line({ seq: 5, at: 30, runId: 'r1', kind: 'run_dispatched' })}\n`
    expect(runSummary(readLedger('/u', fakeFs({ '/u/remote/ledger/session-ledger.log': twice })), 'r1').dispatches).toBe(2)
  })

  it('links the App command id to the ledger run, from events or the snapshot', () => {
    const ledger = readLedger('/u', fakeFs({ '/u/remote/ledger/session-ledger.log': log }))
    expect(runIdForIntent(ledger, 'i2')).toBe('r2')
    expect(runIdForIntent(ledger, 'missing')).toBeNull()
    const compacted = readLedger('/u', fakeFs({
      '/u/remote/ledger/session-ledger.snapshot.json': JSON.stringify({ version: 1, checksum: 'x', snapshot: { lastSeq: 9, runs: [{ runId: 'r9', intentId: 'i9', lifecycle: 'settled' }], retainedEvents: [] } })
    }))
    expect(runIdForIntent(compacted, 'i9')).toBe('r9')
    // After compaction the dispatch count is not exact: the intent is no longer in the tail.
    expect(runSummary(compacted, 'r9')).toMatchObject({ terminal: 'settled', dispatchCountExact: false })
  })

  it('links the App run id through the ledger bound event, and a refused start through its prompt', () => {
    const bound = `${log}${line({ seq: 5, at: 12, runId: 'r2', kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: 'r2', scryRunId: 'remote-run-x-0' }) })}\n`
    const ledger = readLedger('/u', fakeFs({ '/u/remote/ledger/session-ledger.log': bound }))
    expect(runIdForScryRun(ledger, 'remote-run-x-0')).toBe('r2')
    expect(runIdForScryRun(ledger, 'remote-run-y-0')).toBeNull()
    expect(runIdForPrompt(ledger, 'hold abc', 9)).toBe('r1')
    // An intent recorded before this start belongs to an earlier one.
    expect(runIdForPrompt(ledger, 'hold abc', 5_000)).toBeNull()
  })

  it('merges retained snapshot events with the log without double counting', () => {
    const events = mergeEvents([{ seq: 1, runId: 'a', kind: 'run_dispatched' }], [{ seq: 1, runId: 'a', kind: 'run_dispatched' }, { seq: 2, runId: 'a', kind: 'run_settled' }])
    expect(events.map((event) => event.seq)).toEqual([1, 2])
  })

  it('finds intents by exact prompt and reports a missing ledger as missing', () => {
    const ledger = readLedger('/u', fakeFs({ '/u/remote/ledger/session-ledger.log': log }))
    expect(intentsForPrompt(ledger, 'hold abc').map((event) => event.runId)).toEqual(['r1'])
    expect(intentsForPrompt(ledger, 'hold ab')).toEqual([])
    expect(readLedger('/u', fakeFs({})).status).toBe('missing')
  })
})
