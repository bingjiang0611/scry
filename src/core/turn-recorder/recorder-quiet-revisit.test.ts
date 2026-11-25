import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { safeKey } from './store'
import { recorderHasOpenTurn } from './runtime-state'
import { resetTranscriptReadStats, transcriptReadStats } from './recorder-transcript-io'
import { resetTranscriptSnapshotCache } from './recorder-transcript-cache'
import { deferQuietSession, forgetSessionVisit, SESSION_REVISIT_MS } from './session-visit'
import { payload, roots, workspace } from './recorder-tests/fixture.test'

const MINUTE = 60_000

/** Managed capture requires the strict capture set, including diffs, which the shared fixture omits. */
async function managedWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-quiet-managed-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'quiet-managed', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}
const INCREMENTAL = { incremental: true } as const

/**
 * One recovery pass, with the transcript-read counters zeroed first. A pass that skips the session
 * reads no transcript at all, which is the whole point: re-parsing a silent transcript to reach the
 * verdict it already reached is what kept a quiet workspace busy.
 */
async function pass(root: string): Promise<number> {
  resetTranscriptSnapshotCache()
  resetTranscriptReadStats()
  await recoverRecorder(root, {}, undefined, undefined, INCREMENTAL)
  return transcriptReadStats().bytesRead
}

async function backdate(paths: string[], ms: number): Promise<void> {
  const at = new Date(Date.now() - ms)
  for (const path of paths) await utimes(path, at, at).catch(() => undefined)
}

/**
 * A turn whose transcript says the reply stopped to call a tool, and whose files have not moved for
 * two hours: nothing terminal will ever arrive, the quiet window is long past, and expiry is off
 * (only an operator may use it), so every pass re-derives the same "still open, no proof".
 */
async function quietSession(root: string, sessionId: string, options: { backdate: boolean }): Promise<{
  dataRoot: string
  sessionDir: string
  marker: string
}> {
  const transcript = join(root, `${sessionId}.jsonl`)
  const at = new Date(Date.now() - 120 * MINUTE).toISOString()
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', timestamp: at, promptId: 'prompt-1', requestSetId: 'request-1', message: { role: 'user', content: 'run the tests' } }),
    JSON.stringify({ type: 'assistant', timestamp: at, promptId: 'prompt-1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'running' }] } })
  ].join('\n') + '\n')
  await handleRecorderHook({
    provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
    payload: payload(sessionId, { prompt: 'run the tests', transcript_path: transcript, request_set_id: 'request-1', timestamp: at })
  })
  const dataRoot = join(root, '.scry')
  const sessionDir = join(dataRoot, 'runtime', 'qoder', safeKey(sessionId))
  if (options.backdate) {
    const turns = await readdir(join(sessionDir, 'turns')).catch(() => [] as string[])
    await backdate([
      transcript,
      sessionDir,
      join(sessionDir, 'open.json'),
      join(sessionDir, 'session.json'),
      join(sessionDir, 'turns'),
      ...(await Promise.all(turns.map(async (name) => {
        const events = join(sessionDir, 'turns', name, 'events')
        const files = await readdir(events).catch(() => [] as string[])
        return [
          join(sessionDir, 'turns', name),
          events,
          join(sessionDir, 'turns', name, 'pending-open.json'),
          ...files.map((file) => join(events, file))
        ]
      }))).flat()
    ], 120 * MINUTE)
  }
  return { dataRoot, sessionDir, marker: join(dataRoot, 'runtime', 'attention', `qoder__${safeKey(sessionId)}`) }
}

it('defers a quiet session it already judged unresolved, and looks again once the hour has passed', async () => {
  const root = await workspace()
  const { dataRoot, sessionDir } = await quietSession(root, 's-quiet', { backdate: true })

  expect(await pass(root)).toBeGreaterThan(0)
  expect(await pass(root)).toBe(0)
  await expect(deferQuietSession(dataRoot, 'qoder', sessionDir)).resolves.toBe(true)

  await expect(deferQuietSession(dataRoot, 'qoder', sessionDir, Date.now() + SESSION_REVISIT_MS + MINUTE)).resolves.toBe(false)
})

it('never defers a session whose own files say something moved', async () => {
  const root = await workspace()
  const { sessionDir } = await quietSession(root, 's-moving', { backdate: true })
  expect(await pass(root)).toBeGreaterThan(0)

  await writeFile(join(sessionDir, 'open.json'), await readFile(join(sessionDir, 'open.json'), 'utf8'))
  expect(await pass(root)).toBeGreaterThan(0)
})

it('never defers a session whose files are still recent: time alone can still change that answer', async () => {
  const root = await workspace()
  const { dataRoot, sessionDir } = await quietSession(root, 's-fresh', { backdate: false })
  expect(await pass(root)).toBeGreaterThan(0)
  // The turn has been quiet for a moment, not for the stale window: silence has not yet become the
  // evidence a verdict may rest on, so the session keeps full frequency.
  expect(await pass(root)).toBeGreaterThan(0)
  await expect(deferQuietSession(dataRoot, 'qoder', sessionDir)).resolves.toBe(false)
})

it('ends the deferral as soon as that session produces an event', async () => {
  const root = await workspace()
  const { dataRoot } = await quietSession(root, 's-woken', { backdate: true })
  expect(await pass(root)).toBeGreaterThan(0)
  expect(await pass(root)).toBe(0)

  await handleRecorderHook({
    provider: 'qoder', event: 'PostToolUse:Bash', workspace: root,
    payload: payload('s-woken', { tool_name: 'Bash', tool_use_id: 'tool-1', tool_response: 'ok' })
  })
  expect(await pass(root)).toBeGreaterThan(0)
  // The event wrote a tool record but left the answer unchanged, so the next pass waits again
  // instead of staying at full frequency.
  expect(await pass(root)).toBe(0)
  await expect(deferQuietSession(dataRoot, 'qoder', join(dataRoot, 'runtime', 'qoder', safeKey('s-woken')))).resolves.toBe(true)
})

it('forgets the record when the hook path says so directly', async () => {
  const root = await workspace()
  const { dataRoot, sessionDir } = await quietSession(root, 's-forget', { backdate: true })
  expect(await pass(root)).toBeGreaterThan(0)
  expect(await pass(root)).toBe(0)

  forgetSessionVisit(dataRoot, 'qoder', safeKey('s-forget'))
  await expect(deferQuietSession(dataRoot, 'qoder', sessionDir)).resolves.toBe(false)
  expect(await pass(root)).toBeGreaterThan(0)
})

it('always visits a session an operator names, and leaves its turn and marker untouched', async () => {
  const root = await workspace()
  const { sessionDir, marker } = await quietSession(root, 's-scoped', { backdate: true })
  const openBefore = await readFile(join(sessionDir, 'open.json'), 'utf8')
  expect(await pass(root)).toBeGreaterThan(0)
  expect(await pass(root)).toBe(0)

  // Deferring is scheduling only: the turn is still open, its state is byte-identical, its marker
  // is still there, and asking for that session by name always visits it.
  expect(JSON.parse(openBefore).status).toBe('open')
  expect(await readFile(join(sessionDir, 'open.json'), 'utf8')).toBe(openBefore)
  expect(await readFile(marker, 'utf8')).toBe('')
  await expect(recorderHasOpenTurn(join(root, '.scry'))).resolves.toBe(true)

  resetTranscriptSnapshotCache()
  resetTranscriptReadStats()
  await recoverRecorder(root, {}, undefined, { provider: 'qoder', sessionId: 's-scoped' }, INCREMENTAL)
  expect(transcriptReadStats().bytesRead).toBeGreaterThan(0)
})

it('never defers a managed session: its recovery pass only runs because the loop saw one', async () => {
  const root = await managedWorkspace()
  await handleRecorderHook({
    provider: 'codex', event: 'UserPromptSubmit', workspace: root, managed: true,
    payload: { session_id: 'managed-quiet', turn_id: 'turn-1', prompt: '/rate-workflow 1', timestamp: '2026-07-29T12:00:00.000Z' }
  })
  const dataRoot = join(root, '.scry')
  const sessionDir = join(dataRoot, 'runtime', 'codex', safeKey('managed-quiet'))
  const turns = await readdir(join(sessionDir, 'turns')).catch(() => [] as string[])
  await backdate([
    sessionDir,
    join(sessionDir, 'open.json'),
    join(sessionDir, 'session.json'),
    join(sessionDir, 'turns'),
    ...turns.map((name) => join(sessionDir, 'turns', name))
  ], 120 * MINUTE)

  await expect(recoverRecorder(root, {}, undefined, undefined, INCREMENTAL)).resolves.toMatchObject({ pending: 1 })
  await expect(recoverRecorder(root, {}, undefined, undefined, INCREMENTAL)).resolves.toMatchObject({ pending: 1 })
  await expect(deferQuietSession(dataRoot, 'codex', sessionDir)).resolves.toBe(false)
})

it('never defers a session whose open turn recorded its host: a dead host closes it on the next pass', async () => {
  const root = await workspace()
  const { dataRoot, sessionDir } = await quietSession(root, 's-host', { backdate: true })
  const host = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise((resolve) => host.once('spawn', resolve))
  const openPath = join(sessionDir, 'open.json')
  const open = JSON.parse(await readFile(openPath, 'utf8')) as Record<string, unknown>
  open.host = [{ pid: host.pid }]
  await writeFile(openPath, JSON.stringify(open))
  await backdate([openPath, sessionDir], 120 * MINUTE)
  const expiry = { incremental: true, expireOpen: true } as const
  try {
    // The host is alive, so silence is still not an answer.
    await expect(recoverRecorder(root, {}, undefined, undefined, expiry)).resolves.toMatchObject({ recovered: 0 })
    await expect(deferQuietSession(dataRoot, 'qoder', sessionDir)).resolves.toBe(false)

    await new Promise((resolve) => { host.once('exit', resolve); host.kill() })
    // Nothing on disk changed between these two passes but the process table.
    await expect(recoverRecorder(root, {}, undefined, undefined, expiry)).resolves.toMatchObject({ recovered: 1, expired: 1 })
  } finally {
    if (host.exitCode === null) host.kill()
  }
})
