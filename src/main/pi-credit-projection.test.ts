import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { creditUsageEvidence, isCreditUsageEvidence } from '../shared/credit-usage'
import type { LoadedSessionTurn } from '../shared/session-history'
import { enrichPiHistoryCredits, readPiCreditUsage } from './pi-credit-projection'
import { readPiCreditRequests } from './pi-credit-reader'
import * as nativeHistory from './pi-native-history'
import { piCreditRequests } from './pi-credit-usage'
import { readQoderCreditRows } from './qoder-credits'
import { upsertTraceArchiveTurn } from './transcript-archive'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scry-pi-credit-projection-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const sessionRoot = join(root, 'sessions')
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const directory = join(sessionRoot, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  mkdirSync(directory, { recursive: true })
  const sessionFile = join(directory, `2026-10-28_${sessionId}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id: sessionId, cwd },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user' } },
    { type: 'custom', id: 'c1', parentId: 'u1', customType: 'qoder-credit-observation-v1', data: {
      version: 1, sessionId, requestId: 'request-1', modelId: 'dfmodel', status: 'reported', outcome: 'complete', billable: true, credits: 2.5
    } },
    { type: 'message', id: 'a1', parentId: 'c1', message: { role: 'assistant', provider: 'qoder' } }
  ]
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const turn: LoadedSessionTurn = { runId: 'run-1', providerTurnId: 'u1', userText: 'one', done: true, items: [{
    id: 'result-1', runId: 'run-1', ts: '2026-10-28T09:00:00Z', kind: 'harness', stage: 'result',
    providerId: 'pi', runtimeProvider: 'pi_rpc', upstreamProvider: 'qoder'
  }] }
  return { cwd, sessionRoot, sessionId, sessionFile, entries, turn }
}

describe('Pi Credit delivery and historical projection', () => {
  it('recovers an archived turn through the native root, without mutation or double counting', async () => {
    const f = fixture()
    const enriched = await enrichPiHistoryCredits([f.turn], f)
    const credits = enriched[0].items.at(-1)!.creditUsage!
    expect(credits).toMatchObject({ status: 'partial', source: ['pi_qoder_credit_observation'], value: { amount: 2.5, knownRequests: 1, missingRequests: 0 } })
    expect(isCreditUsageEvidence(credits)).toBe(true)
    expect(f.turn.items).toHaveLength(1)
    rmSync(f.sessionFile)
    expect(await enrichPiHistoryCredits(enriched, f)).toEqual(enriched)
  })

  it('replaces unavailable history evidence but never adds native amounts to a known snapshot', async () => {
    const f = fixture()
    f.turn.items.push({ ...f.turn.items[0], id: 'run-1:pi-credit-usage', stage: 'credit_usage', creditUsage: creditUsageEvidence([], 'pi_qoder_credit_observation') })
    const [enriched] = await enrichPiHistoryCredits([f.turn], f)
    expect(enriched.items.filter((event) => event.stage === 'credit_usage')).toHaveLength(1)
    expect(enriched.items.at(-1)!.creditUsage!.value!.amount).toBe(2.5)
  })

  it('reads the adapter-proven custom session file and leaves unmatched user identities unavailable', async () => {
    const f = fixture()
    const results = await readPiCreditUsage({ ...f, turns: [{ runId: 'run-1', providerTurnId: 'u1' }, { runId: 'untracked', providerTurnId: 'wrong' }] })
    expect(results.get('run-1')!.value!.amount).toBe(2.5)
    expect(results.get('untracked')!.status).toBe('unavailable')
  })

  it('rejects wrong cwd/session identity and symlinks without failing the run', async () => {
    const f = fixture()
    const turns = [{ runId: 'run-1', providerTurnId: 'u1' }]
    const wrong = await readPiCreditUsage({ ...f, cwd: '/wrong', turns })
    expect(wrong.get('run-1')!.status).toBe('unavailable')
    const link = join(f.sessionRoot, 'link.jsonl')
    symlinkSync(f.sessionFile, link)
    expect((await readPiCreditUsage({ ...f, sessionFile: link, turns })).get('run-1')!.status).toBe('unavailable')
  })

  it('meters >64 MiB through live receipt, history and analytics without counting discarded payloads', async () => {
    const f = fixture()
    const file = await open(f.sessionFile, 'w')
    try {
      await file.writeFile(f.entries.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      const payload = 'x'.repeat(1024 * 1024)
      for (let i = 0; i < 65; i++) await file.writeFile(JSON.stringify({
        type: 'message', id: `tool-${i}`, parentId: 'u1', message: { role: 'toolResult', content: payload }
      }) + '\n')
      await file.writeFile(f.entries.slice(2).map((entry) => JSON.stringify(entry)).join('\n'))
    } finally { await file.close() }
    expect((await stat(f.sessionFile)).size).toBeGreaterThan(64 * 1024 * 1024)
    const turns = [{ runId: 'run-1', providerTurnId: 'u1' }]
    const live = await readPiCreditUsage({ ...f, turns })
    const history = await readPiCreditUsage({ cwd: f.cwd, sessionId: f.sessionId, sessionRoot: f.sessionRoot, turns })
    expect(history).toEqual(live)
    expect(history.get('run-1')!.value).toMatchObject({ amount: 2.5, knownRequests: 1, missingRequests: 0 })
    const userDataDir = join(f.sessionRoot, 'app')
    expect(upsertTraceArchiveTurn({ ...f, userDataDir, providerId: 'pi', runtimeProvider: 'pi_rpc', turn: { ...f.turn, runId: 'run-1', done: true } })).toBe(true)
    const [row] = await readQoderCreditRows({ userDataDir, projectsDir: join(f.sessionRoot, 'absent'), piSessionRoot: f.sessionRoot,
      scopes: [{ providerId: 'pi', runId: 'run-1', sessionId: f.sessionId, cwd: f.cwd, tsStart: 1 }] })
    expect(row.evidence).toMatchObject({ credits: 2.5, knownRequests: 1, missingRequests: 0 })
  })

  it('preserves forward ancestry, abandoned branches, fork exclusion and permanent request conflicts while streaming', async () => {
    const f = fixture()
    const observation = f.entries[2]
    const entries = [f.entries[0], observation, f.entries[1], f.entries[3],
      { ...observation, id: 'foreign', data: { ...observation.data, sessionId: 'fork-parent' } },
      { ...observation, id: 'abandoned', data: { ...observation.data, requestId: 'second', credits: 5 } },
      { ...observation, id: 'duplicate', data: { ...observation.data, requestId: 'second', credits: 5 } },
      { ...observation, id: 'conflict', data: { ...observation.data, credits: 6 } },
      { ...observation, id: 'copy' },
      { ...observation, id: 'free', data: { ...observation.data, requestId: 'free', billable: false } },
      { type: 'message', id: 'external', parentId: 'a1', message: { role: 'user' } },
      { ...observation, id: 'untracked', parentId: 'external', data: { ...observation.data, requestId: 'external' } }]
    const source = entries.map((entry) => JSON.stringify(entry)).join('\r\n')
    writeFileSync(f.sessionFile, source)
    const turns = [{ runId: 'run-1', providerTurnId: 'u1' }]
    const result = await readPiCreditRequests({ ...f, turns })
    expect(result).toEqual(piCreditRequests(source, f, turns))
    expect(result.requests.map((request) => request.credits)).toEqual([null, 5, 0])
    writeFileSync(f.sessionFile, source + '\n' + JSON.stringify(observation))
    await expect(readPiCreditRequests({ ...f, turns })).rejects.toThrow('duplicated')
  })

  it('rejects interior corruption even when the final record is unfinished, and enforces an entry budget', async () => {
    const f = fixture()
    const turns = [{ runId: 'run-1', providerTurnId: 'u1' }]
    const source = f.entries.map((entry) => JSON.stringify(entry)).join('\r\n')
    const streamed = await readPiCreditRequests({ ...f, turns })
    expect(streamed).toEqual(piCreditRequests(source, f, turns))
    await expect(readPiCreditRequests({ ...f, turns, budget: { remainingEntries: 2 } })).rejects.toThrow('entry budget')
    writeFileSync(f.sessionFile, source + '\n{broken}\n{"type":')
    expect((await readPiCreditUsage({ ...f, turns })).get('run-1')!.status).toBe('unavailable')
  })

  it('rejects a same-size rewrite before releasing streamed credit evidence', async () => {
    const f = fixture()
    const lines = nativeHistory.nativeLines
    vi.spyOn(nativeHistory, 'nativeLines').mockImplementationOnce(async function* (...args) {
      yield* lines(...args)
      writeFileSync(f.sessionFile, f.entries.map(entry => JSON.stringify(entry)).join('\n').replace('"credits":2.5', '"credits":7.5') + '\n')
    })
    const evidence = (await readPiCreditUsage({ ...f, turns: [{ runId: 'run-1', providerTurnId: 'u1' }] })).get('run-1')!
    expect(evidence.status).toBe('unavailable')
    expect(evidence.value!.amount).toBeUndefined()
    expect(evidence.omissionReason).toContain(new nativeHistory.PiNativeHistoryStaleError().message)
  })

  it('allows tail growth while verifying only the original credit snapshot', async () => {
    const f = fixture()
    const lines = nativeHistory.nativeLines
    vi.spyOn(nativeHistory, 'nativeLines').mockImplementationOnce(async function* (...args) {
      yield* lines(...args)
      appendFileSync(f.sessionFile, JSON.stringify({ ...f.entries[2], id: 'c2', parentId: 'a1',
        data: { ...f.entries[2].data, requestId: 'request-2', credits: 5 } }) + '\n')
    })
    const args = { ...f, turns: [{ runId: 'run-1', providerTurnId: 'u1' }] }
    expect((await readPiCreditUsage(args)).get('run-1')!.value!.amount).toBe(2.5)
    expect((await readPiCreditUsage(args)).get('run-1')!.value!.amount).toBe(7.5)
  })

  it('preserves a complete prefix with an explicitly incomplete tail', async () => {
    const f = fixture()
    writeFileSync(f.sessionFile, f.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{"type":')
    const evidence = (await readPiCreditUsage({ ...f, turns: [{ runId: 'run-1', providerTurnId: 'u1' }] })).get('run-1')!
    expect(evidence.value!.amount).toBe(2.5)
    expect(evidence.omissionReason).toContain('tail is incomplete')
  })
})
