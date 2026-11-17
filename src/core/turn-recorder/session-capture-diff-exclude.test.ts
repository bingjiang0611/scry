import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applySessionCaptureHook, startSessionCapture, stopSessionCapture } from './session-capture'
import {
  CaptureRequestError,
  captureContextPath,
  captureStatePath,
  parseSessionCaptureContext,
  type SessionCaptureContext
} from './session-capture-contract'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { readJson } from './io'
import { listRecords } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-capture-exclude-'))
  roots.push(root)
  return root
}

async function transcript(root: string): Promise<string> {
  const path = join(root, 'rollout.jsonl')
  const startedAt = '2026-07-19T12:00:00.000Z'
  await writeFile(path, `${[
    { timestamp: '2026-07-19T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1', cwd: root } },
    { timestamp: startedAt, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: new Date(Date.parse(startedAt) + 10).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'start the workflow' } }
  ].map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function context(transcriptPath: string, captureId = 'capture-1', extra: Partial<SessionCaptureContext> = {}): SessionCaptureContext {
  return {
    protocol: 'codelens.session-capture.v1',
    captureId,
    sessionId: 'sess-1',
    cwd: '/workspace',
    host: 'codex',
    transcriptPath,
    openedAt: '2026-07-19T12:00:01.000Z',
    source: 'friday',
    task: 'REQ-123',
    ...extra
  }
}

function claimPayload(transcriptPath: string): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codelens scry capture start' },
    transcript_path: transcriptPath,
    timestamp: '2026-07-19T12:00:01.000Z'
  }
}

async function start(root: string, transcriptPath: string, diffExclude?: string[], captureId = 'capture-1') {
  return startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath, captureId, diffExclude ? { diffExclude } : {}),
    payload: claimPayload(transcriptPath),
    cli: {}
  })
}

it('declared exclusion paths travel with the claim and reach the published context', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root)
  const run = join(root, 'friday-88733196')
  expect((await start(root, transcriptPath, [run, '/tmp/outside'])).status).toBe('started')
  const session = recorderSessionRoot(join(root, '.scry'), 'codex', 'sess-1')
  expect(await readJson(captureStatePath(join(root, '.scry'), 'codex', 'sess-1'))).toMatchObject({ diffExclude: [run, '/tmp/outside'] })
  expect(await readJson(captureContextPath(join(root, '.scry'), 'codex', 'sess-1'))).toMatchObject({
    diffExclude: [run, '/tmp/outside']
  })
  expect((await readJson<RecorderOpenTurnState>(recorderOpenPath(session)))?.capture?.diffExclude).toEqual([run, '/tmp/outside'])
})

it('a repeated start only ever adds paths, and the union reaches every copy the diff reads', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root)
  const first = join(root, 'friday-88733196')
  const second = join(root, 'materials')
  await start(root, transcriptPath, [first])
  const again = await start(root, transcriptPath, [second])
  expect(again.status).toBe('already_started')
  const session = recorderSessionRoot(join(root, '.scry'), 'codex', 'sess-1')
  const merged = [first, second]
  expect(await readJson(captureStatePath(join(root, '.scry'), 'codex', 'sess-1'))).toMatchObject({ diffExclude: merged })
  expect(await readJson(captureContextPath(join(root, '.scry'), 'codex', 'sess-1'))).toMatchObject({ diffExclude: merged })
  expect((await readJson<RecorderOpenTurnState>(recorderOpenPath(session)))?.capture?.diffExclude).toEqual(merged)
  // A start that declares only the first path again cannot narrow the union.
  await start(root, transcriptPath, [first])
  expect(await readJson(captureStatePath(join(root, '.scry'), 'codex', 'sess-1'))).toMatchObject({ diffExclude: merged })
})

it('the exclusion belongs to the capture, so the next capture of the session starts without it', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root)
  const run = join(root, 'friday-88733196')
  await start(root, transcriptPath, [run])
  await stopSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath)
  })
  await start(root, transcriptPath, undefined, 'capture-2')
  const state = await readJson<Record<string, unknown>>(captureStatePath(join(root, '.scry'), 'codex', 'sess-1'))
  expect(state?.captureId).toBe('capture-2')
  expect(state).not.toHaveProperty('diffExclude')
})

it('rejects exclusion paths that are not absolute', () => {
  // The wire document is what the recorder validates, so spell it the way CodeLens sends it.
  const base = { ...context(''), transcript_path: '/tmp/rollout.jsonl' }
  for (const value of [['relative/path'], '/tmp/single', [42], ['/tmp/ok', 'bad']]) {
    expect(() => parseSessionCaptureContext({ ...base, diffExclude: value }, 'codex'))
      .toThrow(CaptureRequestError)
  }
  expect(parseSessionCaptureContext({ ...base, diffExclude: ['/tmp/a', '/tmp/a', '/tmp/b'] }, 'codex').diffExclude)
    .toEqual(['/tmp/a', '/tmp/b'])
})

it('the transcript is never touched by an integration exclusion', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root)
  const before = await readFile(transcriptPath, 'utf8')
  await start(root, transcriptPath, [root])
  expect(await readFile(transcriptPath, 'utf8')).toBe(before)
})

async function git(repo: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
      }
    }, (error, _stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve())
  })
}

async function repository(): Promise<string> {
  // Git reports the resolved root, so the fixture compares against the same form.
  const root = await realpath(await workspace())
  await git(root, ['init', '-q', '-b', 'main'])
  await writeFile(join(root, 'tracked.txt'), 'v1\n')
  // The recorder's own data directory is not part of what the turn changed.
  await writeFile(join(root, '.gitignore'), '.scry/\n')
  await git(root, ['add', 'tracked.txt', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'base'])
  return root
}

it('a claimed session keeps its run directory out of the record diff and says what it cost', async () => {
  const root = await repository()
  const transcriptPath = await transcript(root)
  const run = join(root, 'friday-88733196')
  await start(root, transcriptPath, [run])

  // The workflow writes its own stage material, and the turn also edits a tracked file.
  await mkdir(run, { recursive: true })
  for (const name of ['plan.md', 'notes.md', 'trace.json']) {
    await writeFile(join(run, name), `${name} body\n`)
  }
  await writeFile(join(root, 'tracked.txt'), 'v2\n')

  const applied = await applySessionCaptureHook({
    workspace: root,
    provider: 'codex',
    event: 'Stop',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: { session_id: 'sess-1', hook_event_name: 'Stop', transcript_path: transcriptPath, timestamp: '2026-07-19T12:00:05.000Z' }
  })
  expect(applied.status).toBe('accepted')
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const diffs = records[0].diff.value ?? []
  const workspace = diffs.find((diff) => diff.repoRoot === root)
  // Excluded material keeps neither a清单 entry nor a body; the tracked edit is untouched.
  expect(workspace?.files.map((file) => file.path)).toEqual([join(root, 'tracked.txt')])
  expect(workspace?.files[0].change).toBe('modified')
  // What the exclusion cost stays provable from the record: paths and counts, no bodies.
  expect(workspace?.diffExclude).toEqual({ paths: [run], files: 3 })
  expect(records[0].diff.omissionReason).toContain('3 file(s) were left out of this diff')
  expect(JSON.stringify(records[0])).not.toContain('plan.md body')
})

it('the same turn without a declaration records the material files', async () => {
  const root = await repository()
  const transcriptPath = await transcript(root)
  const run = join(root, 'friday-88733196')
  await start(root, transcriptPath)
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'plan.md'), 'plan body\n')
  await writeFile(join(root, 'tracked.txt'), 'v2\n')
  await applySessionCaptureHook({
    workspace: root,
    provider: 'codex',
    event: 'Stop',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: { session_id: 'sess-1', hook_event_name: 'Stop', transcript_path: transcriptPath, timestamp: '2026-07-19T12:00:05.000Z' }
  })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const workspace = records[0].diff.value?.find((diff) => diff.repoRoot === root)
  expect(workspace?.files.map((file) => file.path).sort())
    .toEqual([join(root, 'friday-88733196/plan.md'), join(root, 'tracked.txt')])
  expect(workspace?.diffExclude).toBeUndefined()
  // The claim-based baseline caveat is expected; the exclusion note must not appear.
  expect(records[0].diff.omissionReason ?? '').not.toContain('left out of this diff')
})
