import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { creditUsageEvidence, isCreditUsageEvidence } from '../shared/credit-usage'
import type { LoadedSessionTurn } from '../shared/session-history'
import { enrichPiHistoryCredits, readPiCreditUsage } from './pi-credit-projection'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
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

  it('preserves a complete prefix with an explicitly incomplete tail', async () => {
    const f = fixture()
    writeFileSync(f.sessionFile, f.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{"type":')
    const evidence = (await readPiCreditUsage({ ...f, turns: [{ runId: 'run-1', providerTurnId: 'u1' }] })).get('run-1')!
    expect(evidence.value!.amount).toBe(2.5)
    expect(evidence.omissionReason).toContain('tail is incomplete')
  })
})
