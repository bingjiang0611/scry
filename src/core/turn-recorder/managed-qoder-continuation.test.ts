import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'
import { commitManagedRecorderTurn, prepareManagedRecorderTurn } from './managed'
import { handleRecorderHook } from './recorder'
import { listRecords, stableHash } from './store'

// Round nine I2 (CLI 1.1.89): Qoder hook payloads carry no prompt id. Each background task's
// notice reached the recorder as another UserPromptSubmit of the same Scry run with different
// text; it replaced the run's open lifecycle, leaving two provisional lifecycles of this run,
// and the commit failed ("2 lifecycles: 0 with a turn id, 2 from this run; 0 matched").
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const prompt = 'delegate two agents'
const hash = createHash('sha256').update(prompt).digest('hex')
const timing = { startedAt: '2026-11-16T12:00:00.000Z', completedAt: '2026-11-16T12:01:12.000Z', durationMs: 72_000 }

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-continuation-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'continuation', dataDir: '.scry', repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}

function hook(root: string, event: 'UserPromptSubmit' | 'Stop', runId: string, payload: Record<string, unknown>, at: string) {
  return handleRecorderHook({
    provider: 'qoder', event, workspace: root, managed: true,
    payload: { session_id: 'qoder-session', timestamp: at, ...payload },
    env: { ...process.env, SCRY_MANAGED_RUN_ID: runId, SCRY_MANAGED_PROMPT_HASH: hash }
  })
}

async function commit(root: string) {
  const events: TraceEvent[] = [
    { id: 'text', ts: timing.completedAt, runId: 'run-1', kind: 'model', stage: 'text', text: 'both agents done' },
    { id: 'result', ts: timing.completedAt, runId: 'run-1', kind: 'harness', stage: 'result', durationMs: timing.durationMs }
  ]
  const evidence = aggregateTurnEvidence({ userText: prompt, events, source: 'scry_provider_adapter' })
  const base = { workspace: root, provider: 'qoder' as const, sessionId: 'qoder-session', runId: 'run-1', providerTurnId: 'p-root',
    userText: prompt, evidence, timing, status: 'completed' as const, archiveFingerprint: stableHash({ evidence, timing }) }
  const prepared = await prepareManagedRecorderTurn(base)
  if (prepared.status !== 'prepared') throw new Error(`not prepared: ${JSON.stringify(prepared)}`)
  return commitManagedRecorderTurn({ ...base, recordId: prepared.recordId })
}

async function rootTurnThenNotices(root: string, noticeRunId: string) {
  await hook(root, 'UserPromptSubmit', 'run-1', { prompt }, timing.startedAt)
  await hook(root, 'Stop', 'run-1', {}, '2026-11-16T12:00:59.000Z')
  for (const [n, at] of [[1, '2026-11-16T12:00:59.100Z'], [2, '2026-11-16T12:01:10.000Z']] as const) {
    await hook(root, 'UserPromptSubmit', noticeRunId, { prompt: `<task-notification>agent ${n} completed</task-notification>` }, at)
    await hook(root, 'Stop', noticeRunId, {}, at)
  }
}

describe('Qoder notice prompts inside one Scry run', () => {
  it('stay in the run’s open turn, so the root turn commits', async () => {
    const root = await workspace()
    await rootTurnThenNotices(root, 'run-1')
    await expect(commit(root)).resolves.toMatchObject({ status: 'committed' })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ providerTurnId: 'p-root', status: 'completed' })
  })

  it('negative control: a prompt from another run still starts its own turn', async () => {
    const root = await workspace()
    await rootTurnThenNotices(root, 'run-2')
    await expect(commit(root)).rejects.toThrow('differs from the open lifecycle identity')
  })
})
