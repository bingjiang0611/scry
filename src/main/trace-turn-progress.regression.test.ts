import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { persistUnresolvedTraceTurnProgress, recoverTraceTurnProgress } from './trace-turn-progress'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const harness: TraceEvent = { id: 'result', runId: 'run-1', ts: '', kind: 'harness', stage: 'result', isError: true, runtimeFailureStage: 'runtime' }

async function fixture(status: 'failed' | 'cancelled' | 'interrupted' | 'completed', items: TraceEvent[], identity: { providerTurnId?: string; forkTurnId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scry-progress-matrix-'))
  roots.push(root)
  await persistUnresolvedTraceTurnProgress({
    userDataDir: root, cwd: root, providerId: 'qoder', runtimeProvider: 'qoder_cli',
    reason: 'missing_provider_session_id',
    turn: { runId: 'run-1', userText: 'fixture', items, done: true, status, ts: 1, ...identity }
  })
  const path = join(root, 'trace-turn-progress', (await readdir(join(root, 'trace-turn-progress')))[0])
  return { root, path, bytes: await readFile(path) }
}

describe('providerless terminal recovery regression matrix', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)('clears %s only in the matching scope, then remains idempotent', async (status) => {
    for (const items of [[], [harness]]) {
      const { root, path, bytes } = await fixture(status, items)
      for (const filter of [{ cwd: `${root}/other` }, { providerId: 'claude' as const }, { sessionId: 'unrelated' }]) {
        expect(await recoverTraceTurnProgress(root, filter)).toEqual({ recovered: 0, pending: 0, errors: [] })
        expect(await readFile(path)).toEqual(bytes)
      }
      expect(await recoverTraceTurnProgress(root, { cwd: root, providerId: 'qoder' })).toEqual({ recovered: 1, pending: 0, errors: [] })
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await recoverTraceTurnProgress(root)).toEqual({ recovered: 0, pending: 0, errors: [] })
    }
  })

  it.each([
    { label: 'provider turn alone', identity: { providerTurnId: 'turn-1' }, items: [] },
    { label: 'fork identity alone', identity: { forkTurnId: 'fork-1' }, items: [] },
    { label: 'model content alone', identity: {}, items: [{ ...harness, kind: 'model' as const, stage: 'text_delta', text: 'partial' }] },
    { label: 'tool evidence alone', identity: {}, items: [{ ...harness, kind: 'tool' as const, stage: 'tool:Read', tool: 'Read' }] }
  ])('preserves $label independently, without needing another veto condition', async ({ identity, items }) => {
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      const { root, path, bytes } = await fixture(status, items, identity)
      expect(await recoverTraceTurnProgress(root)).toEqual({ recovered: 0, pending: 1, errors: ['unresolved trace turn progress (missing_provider_session_id): run-1'] })
      expect(await readFile(path)).toEqual(bytes)
    }
  })

  it('does not discard a completed turn merely because it is empty', async () => {
    const { root, path, bytes } = await fixture('completed', [])
    expect(await recoverTraceTurnProgress(root)).toMatchObject({ recovered: 0, pending: 1 })
    expect(await readFile(path)).toEqual(bytes)
  })
})
