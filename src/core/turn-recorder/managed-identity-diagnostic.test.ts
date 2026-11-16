import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { aggregateTurnEvidence } from './aggregate'
import { prepareManagedRecorderTurn } from './managed'
import { handleRecorderHook } from './recorder'
import { stableHash } from './store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('says which way a lifecycle identity mismatch went, without IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-identity-diagnostic-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'diag', dataDir: '.scry', repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  const timing = { startedAt: '2026-11-15T12:00:00.000Z', completedAt: '2026-11-15T12:00:10.000Z', durationMs: 10_000 }
  await handleRecorderHook({
    provider: 'qoder', event: 'UserPromptSubmit', workspace: root, managed: true,
    payload: { session_id: 'secret-session', prompt_id: 'secret-other-turn', prompt: 'other', timestamp: timing.startedAt },
    env: { ...process.env, SCRY_MANAGED_RUN_ID: 'secret-run-2', SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('other').digest('hex') }
  })
  const evidence = aggregateTurnEvidence({ userText: 'prompt', source: 'scry_provider_adapter', events: [
    { id: 'text', ts: timing.completedAt, runId: 'run', kind: 'model', stage: 'text', text: 'done' },
    { id: 'result', ts: timing.completedAt, runId: 'run', kind: 'harness', stage: 'result', durationMs: timing.durationMs }
  ] })
  const error = await prepareManagedRecorderTurn({
    workspace: root, provider: 'qoder', sessionId: 'secret-session', runId: 'secret-run-1', providerTurnId: 'secret-root-turn',
    userText: 'prompt', evidence, timing, status: 'completed', archiveFingerprint: stableHash({ timing })
  }).then(() => undefined, (cause: Error) => cause)
  expect(error?.message).toContain('differs from the open lifecycle identity (commit turn id present; 1 lifecycles: 1 with a turn id, 0 from this run, 0 listing it as a continuation; 0 matched)')
  expect(error?.message).not.toContain('secret')
})
