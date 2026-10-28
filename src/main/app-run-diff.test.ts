import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { beginGitTurnDiff } from './git'
import { SessionDiffBaselineRegistry } from './session-diff'
import { createAppRunDiffLifecycle } from './app-run-diff'
import type { TraceEvent } from '../shared/trace'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-app-run-diff-'))
  roots.push(root)
  await writeFile(join(root, 'tracked.txt'), 'before\n')
  await run('git', ['init', '-q', '.'], { cwd: root })
  await run('git', ['add', '.'], { cwd: root })
  await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base'], { cwd: root })
  return root
}

async function fixture() {
  const cwd = await repository()
  const registry = new SessionDiffBaselineRegistry()
  const initialCapture = beginGitTurnDiff(cwd)
  const items: TraceEvent[] = [], queued: TraceEvent[] = []
  let key = 'run-owned-key', sessionId: string | undefined
  let focused = true, viewed = true, revision = 0
  let eventSequence = 0, nowSequence = 0
  const lifecycle = createAppRunDiffLifecycle({
    runId: 'run-diff-fixture', cwd, contextKey: 'provider\0fixture', providerId: 'codex', runtimeProvider: 'codex_cli',
    initialCapture, patchExcludeBasenames: [], sessionDiffBaselines: registry,
    getDiffContextKey: () => key, getObservedSessionId: () => sessionId, getContextRevision: () => revision,
    hints: () => ({}), items, isFocused: () => focused, isViewed: () => viewed,
    queueTrace: event => queued.push(event), eventId: prefix => `${prefix}-${eventSequence++}`,
    now: () => new Date(1_000 + nowSequence++ * 1_000)
  })
  await lifecycle.sessionBaselineReady
  await lifecycle.turnCapture
  return {
    cwd, registry, lifecycle, items, queued,
    promote(nextKey: string, nextSessionId: string) {
      key = registry.promote(key, nextKey, nextSessionId)
      sessionId = nextSessionId
    },
    loseIdentity() { key = 'missing-key'; sessionId = 'different-session'; revision = 7 },
    terminalOnly() { focused = false; viewed = true },
    close: async () => {
      lifecycle.releaseSessionBaseline()
      await lifecycle.cancelTurn()
      registry.disposeAll()
      await Promise.resolve()
    }
  }
}

function event(items: TraceEvent[], stage: string): TraceEvent {
  const value = items.find(item => item.stage === stage)
  if (!value) throw new Error(`Missing ${stage}`)
  return value
}

describe('App run diff lifecycle extraction', () => {
  it('uses the promoted live session identity, previews by focus, and publishes paired terminal evidence by viewed state', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.cwd, 'tracked.txt'), 'after\n')
      await f.lifecycle.notifyChange()
      expect(f.items.filter(item => item.stage.endsWith('_preview'))).toHaveLength(2)
      expect(f.queued.filter(item => item.stage.endsWith('_preview'))).toHaveLength(2)

      f.promote('session-key', 'session-1')
      f.terminalOnly()
      await f.lifecycle.finalizeTurn()
      await f.lifecycle.finalizeSession()
      const turn = event(f.items, 'turn_diff').turnDiff!
      const session = event(f.items, 'session_diff').turnDiff!
      expect(turn.status).toBe('captured')
      expect(session.status).toBe('captured')
      expect(session.baseline).toBe('session_start')
      expect(session.afterAt).toBe(turn.afterAt)
      expect(turn.files.some(file => file.path.endsWith('tracked.txt'))).toBe(true)
      expect(f.queued.filter(item => item.stage === 'turn_diff' || item.stage === 'session_diff')).toHaveLength(2)

      const itemCount = f.items.length, queueCount = f.queued.length
      await f.lifecycle.finalizeTurn()
      await f.lifecycle.finalizeSession()
      await f.lifecycle.notifyChange()
      expect(f.items).toHaveLength(itemCount)
      expect(f.queued).toHaveLength(queueCount)
    } finally { await f.close() }
  })

  it('reads live identity at finalization and records no_baseline instead of reusing a stale run key', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.cwd, 'tracked.txt'), 'changed\n')
      f.loseIdentity()
      await f.lifecycle.finalizeTurn()
      await f.lifecycle.finalizeSession()
      expect(event(f.items, 'turn_diff').turnDiff?.status).toBe('captured')
      expect(event(f.items, 'session_diff').turnDiff).toMatchObject({ status: 'unavailable', reason: 'no_baseline' })
    } finally { await f.close() }
  })
})
