import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as config from './config'
import * as io from './io'
import { listRecords } from './store'
import { applySessionCaptureHook, startSessionCapture } from './session-capture'
import { captureContextPath, captureStatePath, type SessionCaptureContext } from './session-capture-contract'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-capture-initialization-')))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  const transcriptPath = join(root, 'rollout.jsonl')
  const timestamp = '2026-11-17T12:00:00.000Z'
  await writeFile(transcriptPath, `${[
    { timestamp, type: 'session_meta', payload: { id: 'session', cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'fixture request' } }
  ].map(row => JSON.stringify(row)).join('\n')}\n`)
  const context: SessionCaptureContext = {
    protocol: 'codelens.session-capture.v1', captureId: 'capture', sessionId: 'session',
    cwd: root, host: 'codex', transcriptPath, openedAt: timestamp, source: 'fixture', task: null
  }
  const options = {
    workspace: root, provider: 'codex' as const, sessionId: 'session', dataDir: dataRoot,
    context, payload: { session_id: 'session', transcript_path: transcriptPath, timestamp }, cli: {}
  }
  const openPath = recorderOpenPath(recorderSessionRoot(dataRoot, 'codex', 'session'))
  return {
    options, openPath, statePath: captureStatePath(dataRoot, 'codex', 'session'),
    contextPath: captureContextPath(dataRoot, 'codex', 'session')
  }
}

it.each(['current', 'legacy', 'legacy-continuation'])('refuses an interrupted %s initialization instead of ACKing a missing baseline', async format => {
  const f = await fixture()
  const discovery = vi.spyOn(config, 'discoverRepositories').mockRejectedValueOnce(new Error('interrupted discovery'))
  await expect(startSessionCapture(f.options)).rejects.toThrow('interrupted discovery')
  const open = await io.readJson<RecorderOpenTurnState>(f.openPath)
  expect(open).toMatchObject({ status: 'open', generation: 1, captures: [] })
  expect(open?.repositoryDiscovery).toBeUndefined()
  if (format !== 'current') {
    const legacy = JSON.parse(await readFile(f.openPath, 'utf8'))
    delete legacy.initialization
    if (format === 'legacy-continuation') {
      legacy.continuation = { rootRecordId: 'fixture-root', sealedRecordId: 'fixture-sealed', providerTurnId: 'turn' }
    }
    await writeFile(f.openPath, JSON.stringify(legacy))
  }
  discovery.mockRestore()
  await expect(startSessionCapture(f.options)).rejects.toMatchObject({
    code: 'recorder_unavailable', message: expect.stringContaining('initialization')
  })
  expect(await io.readJson(f.statePath)).toBeNull()
  expect(await io.readJson(f.contextPath)).toBeNull()
  expect(await io.readJson(f.openPath)).toMatchObject({ generation: 1, captures: [] })
})

it('accepts a completed no-repository baseline and reuses its generation on retry', async () => {
  const f = await fixture()
  const discovery = vi.spyOn(config, 'discoverRepositories')
  const writes = vi.spyOn(io, 'writeJsonAtomic')
  expect((await startSessionCapture(f.options)).status).toBe('started')
  expect(writes).toHaveBeenCalledWith(f.openPath, expect.objectContaining({ initialization: 'complete' }))
  const open = await io.readJson<RecorderOpenTurnState>(f.openPath)
  expect(open).toMatchObject({ initialization: 'complete', generation: 1, captures: [] })
  expect((await startSessionCapture(f.options)).status).toBe('already_started')
  expect(await io.readJson(f.openPath)).toEqual(open)
  expect(discovery).toHaveBeenCalledTimes(1)
})

it('repairs interrupted context publication before acknowledging a repeated start', async () => {
  const f = await fixture()
  const write = io.writeJsonAtomic
  const publication = vi.spyOn(io, 'writeJsonAtomic').mockImplementation(async (path, value, options) => {
    if (path === f.contextPath) throw new Error('interrupted context publication')
    return write(path, value, options)
  })
  await expect(startSessionCapture(f.options)).rejects.toThrow('interrupted context publication')
  publication.mockRestore()
  const before = await io.readJson(f.openPath)
  const discovery = vi.spyOn(config, 'discoverRepositories')
  await startSessionCapture(f.options)
  expect(await io.readJson(f.contextPath)).toMatchObject({ captureId: 'capture', sessionId: 'session' })
  expect(await io.readJson(f.openPath)).toEqual(before)
  expect(discovery).not.toHaveBeenCalled()
})

it('reuses a real Git baseline after publication fails, preserving immediate changes and the turn boundary', async () => {
  const f = await fixture()
  const exec = promisify(execFile)
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: f.options.workspace,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' }
  })
  await git('init')
  const tracked = join(f.options.workspace, 'tracked.txt')
  await writeFile(tracked, 'before\n')
  await git('add', 'tracked.txt')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
  const write = io.writeJsonAtomic
  const publication = vi.spyOn(io, 'writeJsonAtomic').mockImplementation(async (path, value, options) => {
    if (path === f.statePath) throw new Error('interrupted control publication')
    return write(path, value, options)
  })
  await expect(startSessionCapture(f.options)).rejects.toThrow('interrupted control publication')
  publication.mockRestore()
  const before = await io.readJson<RecorderOpenTurnState>(f.openPath)
  expect(before?.captures).toHaveLength(1)
  await writeFile(tracked, 'after\n')
  await appendFile(f.options.context.transcriptPath, JSON.stringify({
    timestamp: '2026-11-17T12:00:02.000Z', type: 'event_msg',
    payload: { type: 'agent_message', message: 'the tool completed' }
  }) + '\n')
  await startSessionCapture(f.options)
  expect(await io.readJson(f.openPath)).toEqual(before)
  await writeFile(join(f.options.workspace, 'new.txt'), 'new after ACK\n')
  await applySessionCaptureHook({
    ...f.options, event: 'Stop', payload: { ...f.options.payload, timestamp: '2026-11-17T12:00:03.000Z' }
  })
  const records = await listRecords(f.options.dataDir)
  expect(records).toHaveLength(1)
  const files = records[0].diff.value?.flatMap(snapshot => snapshot.files) ?? []
  expect(files.find(file => file.path.endsWith('/tracked.txt'))?.patchContent?.content).toContain('+after')
  expect(files.find(file => file.path.endsWith('/new.txt'))?.patchContent?.content).toContain('+new after ACK')
}, 30_000)

it('refuses a repeated claim when a later turn interrupted initialization', async () => {
  const f = await fixture()
  await startSessionCapture(f.options)
  vi.spyOn(config, 'discoverRepositories').mockRejectedValueOnce(new Error('interrupted later turn'))
  await expect(applySessionCaptureHook({
    ...f.options, event: 'UserPromptSubmit',
    payload: { ...f.options.payload, timestamp: '2026-11-17T13:00:00.000Z', prompt: 'next request' }
  })).rejects.toThrow('interrupted later turn')
  expect(await io.readJson(f.openPath)).toMatchObject({ initialization: 'pending', generation: 2 })
  await expect(startSessionCapture(f.options)).rejects.toMatchObject({ code: 'recorder_unavailable' })
})

it('keeps exclusions persisted in control when open publication is interrupted', async () => {
  const f = await fixture()
  const a = join(f.options.workspace, 'a')
  const b = join(f.options.workspace, 'b')
  const initial = { ...f.options, context: { ...f.options.context, diffExclude: [a] } }
  await startSessionCapture(initial)
  const write = io.writeJsonAtomic
  const publication = vi.spyOn(io, 'writeJsonAtomic').mockImplementation(async (path, value, options) => {
    if (path === f.openPath) throw new Error('interrupted open publication')
    return write(path, value, options)
  })
  await expect(startSessionCapture({ ...initial, context: { ...initial.context, diffExclude: [b] } }))
    .rejects.toThrow('interrupted open publication')
  publication.mockRestore()
  expect(await io.readJson(f.statePath)).toMatchObject({ diffExclude: [a, b] })
  await startSessionCapture(initial)
  expect(await io.readJson(f.openPath)).toMatchObject({ capture: { diffExclude: [a, b] } })
  expect(await io.readJson(f.statePath)).toMatchObject({ diffExclude: [a, b] })
  expect(await io.readJson(f.contextPath)).toMatchObject({ diffExclude: [a, b] })
})

it('serializes concurrent starts into one start and one idempotent ACK', async () => {
  const f = await fixture()
  const results = await Promise.all([startSessionCapture(f.options), startSessionCapture(f.options)])
  expect(results.map(result => result.status).sort()).toEqual(['already_started', 'started'])
  expect(await io.readJson(f.openPath)).toMatchObject({ generation: 1, initialization: 'complete' })
})
