import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { aggregateTurnEvidence } from './aggregate.js'
import { partial } from '../../shared/turn-record.js'
import type { TraceEvent } from '../../shared/trace.js'
import { reserveObservedInterruption } from './managed-interruption.js'
import type { PrepareManagedTurnInput } from './managed.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const timing = { startedAt: '2026-11-12T10:00:00.000Z', completedAt: '2026-11-12T10:00:05.000Z', durationMs: 5000 }

function input(hookEvents: string[]): PrepareManagedTurnInput {
  const events: TraceEvent[] = hookEvents.map((hookEvent, index) => ({
    id: `hook-${index}`, runId: 'run-1', ts: timing.startedAt, kind: 'hook', stage: 'hook_response',
    name: hookEvent, hookId: `hook-${index}`, hookName: `hook-${index}`, hookEvent, hookOutcome: 'success'
  }))
  return {
    allowObservedInterruption: true,
    termination: partial(
      { reason: 'run_ended', completedAtSource: 'recorder_observed_terminal', observedAt: timing.completedAt },
      ['scry_run_boundary'], 'no canonical result timing', 'estimated'
    ),
    workspace: '/unused', provider: 'qoder', sessionId: 'session-1', runId: 'run-1', userText: 'prompt',
    evidence: aggregateTurnEvidence({ userText: 'prompt', events, source: 'scry_provider_adapter' }),
    timing, status: 'interrupted', archiveFingerprint: 'fingerprint'
  }
}

describe('reserveObservedInterruption hook evidence', () => {
  async function reserve(hookEvents: string[]) {
    const root = await mkdtemp(join(tmpdir(), 'scry-observed-interruption-'))
    roots.push(root)
    return reserveObservedInterruption(join(root, 'data'), join(root, 'session'), input(hookEvents))
  }

  it('reserves a turn when only session-level hooks ran', async () => {
    await expect(reserve([])).resolves.toMatchObject({ generation: 1, turnIndex: 1, terminalAtSource: 'recorder_observed_terminal' })
    await expect(reserve(['SessionStart', 'Stop', 'SessionEnd', 'Notification'])).resolves.toMatchObject({ generation: 1 })
  })

  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Hook'])('refuses even when main allowed it, after %s', async (hookEvent) => {
    await expect(reserve(['SessionStart', hookEvent])).resolves.toBeUndefined()
  })
})
