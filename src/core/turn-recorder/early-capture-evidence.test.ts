import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { applySessionCaptureHook, startSessionCapture } from './session-capture'
import { listRecords } from './store'
import { recorderSessionRoot, recorderOpenPath, type RecorderOpenTurnState } from './runtime-state'
import { readJson } from './io'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(provider: 'qoder' | 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'scry-early-claim-'))
  roots.push(root)
  const dataDir = join(root, '.scry')
  const transcriptPath = join(root, 'session.jsonl')
  const timestamp = new Date(Date.now() - 5_000).toISOString()
  const payload = { session_id: 'fixture', transcript_path: transcriptPath, cwd: root, timestamp }
  const base = { workspace: root, dataDir, provider, sessionId: 'fixture', context: {
    protocol: 'codelens.session-capture.v1' as const, captureId: 'early-claim', sessionId: 'fixture', cwd: root,
    host: provider, transcriptPath, openedAt: timestamp, source: 'manual', task: 'fixture'
  } }
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })
  async function initRepo() {
    await git('init')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await writeFile(join(root, '.gitignore'), '*.jsonl\n')
    await git('add', 'tracked.txt', '.gitignore')
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline')
  }
  return { root, dataDir, transcriptPath, timestamp, payload, base, initRepo,
    openPath: recorderOpenPath(recorderSessionRoot(dataDir, provider, 'fixture')),
    hook: (event: string, extra = {}) => applySessionCaptureHook({ ...base, event, payload: { ...payload, ...extra } }) }
}

it('marks a late apply_patch baseline unavailable instead of publishing zero changed files', async () => {
  const f = await fixture('codex')
  await writeFile(f.transcriptPath, [
    { timestamp: f.timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { timestamp: f.timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'edit' } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  await startSessionCapture({ ...f.base, payload: f.payload, cli: {} })
  await f.initRepo()
  const file = join(f.root, 'tracked.txt')
  await writeFile(file, 'already written\n')
  await f.hook('PreToolUse', { turn_id: 'one', tool_name: 'apply_patch', tool_use_id: 'patch-1',
    tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-before\n+already written\n*** End Patch` } })
  await f.hook('Stop', { turn_id: 'one', timestamp: new Date().toISOString() })
  const [record] = await listRecords(f.dataDir)
  expect(record.diff).toMatchObject({ status: 'unavailable', value: [{ status: 'unavailable', reason: 'baseline_after_write', files: [] }] })
})

it.each([true, false])('claims a first Qoder prompt before transcript creation (appears=%s)', async (appears) => {
  const f = await fixture('qoder')
  await f.initRepo()
  const prompt = { ...f.payload, hook_event_name: 'UserPromptSubmit', prompt: 'first prompt', prompt_id: 'one' }
  expect(await startSessionCapture({ ...f.base, payload: prompt, cli: {} })).toMatchObject({ status: 'started' })
  const open = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(open).toMatchObject({ transcriptStartOffset: null, pendingQoderTranscriptPath: expect.stringMatching(/session\.jsonl$/), initialization: 'complete' })
  expect(open?.transcriptPath).toBeUndefined()
  expect(open?.captures[0].capture.status).toBe('ready')
  expect(await f.hook('UserPromptSubmit', prompt)).toMatchObject({ ack: { result: 'duplicate' } })
  await writeFile(join(f.root, 'tracked.txt'), 'after\n')
  if (appears) {
    await writeFile(f.transcriptPath, [
      { type: 'user', promptId: 'one', timestamp: f.timestamp, message: { role: 'user', content: 'first prompt' } },
      { type: 'assistant', promptId: 'one', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  // Even if a later hook presents another path, only the original claim can supply this transcript.
  const other = join(f.root, 'other.jsonl')
  await writeFile(other, '{"type":"user"}\n')
  await f.hook('Stop', { prompt_id: 'one', transcript_path: other, timestamp: new Date().toISOString() })
  const records = await listRecords(f.dataDir)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    user: { value: { text: 'first prompt' } },
    hooks: { value: expect.arrayContaining([expect.objectContaining({ event: 'UserPromptSubmit' })]) },
    diff: { value: [{ files: [expect.objectContaining({ change: 'modified' })] }] },
    transcript: appears
      ? { status: 'available', value: { sourcePath: expect.stringMatching(/\/session\.jsonl$/) } }
      : { status: 'unavailable', omissionReason: expect.stringContaining('did not become available') }
  })
})

it('does not give the missing-first-file exception to a broken symlink', async () => {
  const f = await fixture('qoder')
  await symlink(join(f.root, 'missing'), f.transcriptPath)
  await expect(startSessionCapture({ ...f.base, payload: { ...f.payload, hook_event_name: 'UserPromptSubmit' }, cli: {} }))
    .rejects.toMatchObject({ code: 'recorder_unavailable' })
})
