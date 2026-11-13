import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applySessionCaptureHook, startSessionCapture } from './session-capture'
import type { SessionCaptureContext } from './session-capture-contract'
import { listRecords } from './store'
import { recorderSessionRoot } from './runtime-state'
import { readJson } from './io'
import type { RecorderSessionState } from './runtime-state'
import type { AgentTurnRecord } from '../../shared/turn-record'

const exec = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd })
  return result.stdout
}

/**
 * The Friday layout: a bare cache repository plus a `git worktree add` stage deep enough that the
 * configured discovery depth cannot reach it, with `.git` as a gitdir pointer file.
 */
async function fridayWorkspace(): Promise<{ root: string; worktree: string; transcriptPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scry-capture-worktree-'))
  roots.push(root)
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Scry Test'])
  await git(root, ['config', 'user.email', 'scry@example.invalid'])
  await writeFile(join(root, '.gitignore'), '.friday/\n')
  await writeFile(join(root, 'README.md'), 'project\n')
  await git(root, ['add', '.gitignore', 'README.md'])
  await git(root, ['commit', '-m', 'project baseline'])

  const cache = join(root, '.friday', 'cache', 'backend')
  await mkdir(cache, { recursive: true })
  await git(cache, ['init'])
  await git(cache, ['config', 'user.name', 'Scry Test'])
  await git(cache, ['config', 'user.email', 'scry@example.invalid'])
  await writeFile(join(cache, 'server.ts'), 'export const started = false\n')
  await git(cache, ['add', 'server.ts'])
  await git(cache, ['commit', '-m', 'cache baseline'])

  const worktree = join(root, '.friday', 'run-1', 'stage3', 'backend', 'workspace', 'backend')
  await mkdir(join(worktree, '..'), { recursive: true })
  await git(cache, ['worktree', 'add', worktree, '-b', 'stage-1'])

  const transcriptPath = join(root, 'rollout.jsonl')
  await writeFile(transcriptPath, `${[
    { timestamp: '2026-07-19T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-9', cwd: root } },
    { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'ship the stage change' } }
  ].map((line) => JSON.stringify(line)).join('\n')}\n`)
  return { root, worktree, transcriptPath }
}

function context(transcriptPath: string, captureId = 'capture-friday'): SessionCaptureContext {
  return {
    protocol: 'codelens.session-capture.v1',
    captureId,
    sessionId: 'sess-9',
    cwd: '/workspace',
    host: 'codex',
    transcriptPath,
    openedAt: '2026-07-19T12:00:01.000Z',
    source: 'manual',
    task: 'REQ-77'
  }
}

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return { session_id: 'sess-9', transcript_path: extra.transcript_path, timestamp: '2026-07-19T12:00:01.000Z', ...extra }
}

async function hook(
  root: string,
  transcriptPath: string,
  event: string,
  extra: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof applySessionCaptureHook>>> {
  return applySessionCaptureHook({
    workspace: root,
    provider: 'codex',
    event,
    sessionId: 'sess-9',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: payload({ transcript_path: transcriptPath, ...extra })
  })
}

function snapshotFor(record: AgentTurnRecord, repository: string) {
  const match = (record.diff.value ?? []).find((snapshot) =>
    snapshot.requestedRoot === repository || snapshot.repoRoot === repository)
  if (!match) throw new Error(`no diff snapshot for ${repository}: ${JSON.stringify((record.diff.value ?? []).map((snapshot) => snapshot.requestedRoot))}`)
  return match
}

it('discovers a deep Friday worktree from the edited file, keeps it for later turns, and diffs the commit', async () => {
  const { root, worktree, transcriptPath } = await fridayWorkspace()
  await startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-9',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: payload({
      transcript_path: transcriptPath,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'codelens scry capture start --task REQ-77' }
    }),
    cli: {}
  })

  const source = join(worktree, 'src', 'feature.ts')
  await mkdir(join(worktree, 'src'), { recursive: true })
  // The PreToolUse that names the file arrives before the write, so the baseline is the pre-edit state.
  await hook(root, transcriptPath, 'PreToolUse', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_use_id: 'edit-1',
    tool_input: { file_path: source }
  })
  const session = await readJson<RecorderSessionState>(join(recorderSessionRoot(join(root, '.scry'), 'codex', 'sess-9'), 'session.json'))
  expect(session?.captureRepositories).toContain(worktree)

  await writeFile(source, 'export const feature = true\n')
  await git(worktree, ['add', 'src/feature.ts'])
  await git(worktree, ['commit', '-m', 'stage3: add feature'])

  await hook(root, transcriptPath, 'Stop', { hook_event_name: 'Stop', timestamp: '2026-07-19T12:00:05.000Z' })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const snapshot = snapshotFor(records[0], worktree)
  const changed = snapshot.files.find((file) => file.path.endsWith('/src/feature.ts'))
  expect(changed?.change).toBe('added')
  expect(changed?.added).toBeGreaterThan(0)
  // The commit happened during the turn; its content is still the turn's change.
  expect(changed?.patchContent?.content).toContain('+export const feature = true')

  // The next turn baselines the same repository at turn start, without another tool event.
  await writeFile(transcriptPath, `${[
    { timestamp: '2026-07-19T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-9', cwd: root } },
    { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'ship the stage change' } },
    { timestamp: '2026-07-19T13:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: '2026-07-19T13:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'second turn' } }
  ].map((line) => JSON.stringify(line)).join('\n')}\n`)
  await hook(root, transcriptPath, 'UserPromptSubmit', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'second turn',
    timestamp: '2026-07-19T13:00:00.000Z'
  })
  await writeFile(source, 'export const feature = "second"\n')
  await hook(root, transcriptPath, 'Stop', { hook_event_name: 'Stop', timestamp: '2026-07-19T13:00:05.000Z' })
  const after = await listRecords(join(root, '.scry'))
  expect(after).toHaveLength(2)
  const second = snapshotFor(after[1], worktree)
  expect(second.files.some((file) => file.path.endsWith('/src/feature.ts'))).toBe(true)
  expect(after[1].capture).toMatchObject({ captureId: 'capture-friday', task: 'REQ-77' })
  expect(await readFile(join(worktree, '.git'), 'utf8')).toContain('gitdir:')
}, 30_000)

it('reads Codex apply_patch paths and stops at the worktree gitdir pointer', async () => {
  const { editedAbsolutePaths, nearestRepositoryRoot } = await import('./session-capture-discovery')
  const patch = [
    '*** Begin Patch',
    '*** Update File: /work/stage3/backend/workspace/backend/server.ts',
    '@@ -1 +1 @@',
    '-export const started = false',
    '+export const started = true',
    '*** Add File: relative/path.ts',
    '+nope',
    '*** End Patch'
  ].join('\n')
  expect(editedAbsolutePaths({ tool_input: { command: patch } })).toEqual(['/work/stage3/backend/workspace/backend/server.ts'])
  expect(editedAbsolutePaths({ tool_input: { file_path: '/work/a/b.ts' } })).toEqual(['/work/a/b.ts'])
  // Qoder sends `tool_input` as a dict string with single quotes, not a JSON object.
  expect(editedAbsolutePaths({
    tool_input: "{'file_path': '/work/stage3/backend/workspace/backend/NOTES.md', 'content': 'x'}"
  })).toEqual(['/work/stage3/backend/workspace/backend/NOTES.md'])
  expect(editedAbsolutePaths({ tool_input: { file_path: 'relative/a.ts' } })).toEqual([])

  const { root, worktree } = await fridayWorkspace()
  expect(await nearestRepositoryRoot(join(worktree, 'src', 'feature.ts'))).toBe(worktree)
  expect(await nearestRepositoryRoot(join(root, '.friday', 'cache', 'backend', 'server.ts'))).toBe(join(root, '.friday', 'cache', 'backend'))
}, 30_000)
