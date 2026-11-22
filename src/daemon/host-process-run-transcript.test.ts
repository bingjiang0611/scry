import 'reflect-metadata'
import { appendFileSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveTranscriptInterval } from '../host-runtime/orchestration/transcript-interval'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { transcriptPath } from '../main/transcript-archive'
import { createRecentFoldersStore } from '../main/app-store'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

const sessionId = '3c821d7e-c462-4e64-aba8-ce196bdf5947'
const captureGate = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined }))

vi.mock('../host-runtime/orchestration/transcript-interval', async (importOriginal) => {
  const real = await importOriginal<typeof import('../host-runtime/orchestration/transcript-interval')>()
  return {
    ...real,
    captureTranscriptInterval: async (...args: Parameters<typeof real.captureTranscriptInterval>) => {
      const evidence = await real.captureTranscriptInterval(...args)
      await captureGate.wait
      return evidence
    }
  }
})

vi.mock('../main/providers/smoke', async (importOriginal) => {
  const real = await importOriginal<typeof import('../main/providers/smoke')>()
  return {
    ...real,
    createSmokeProviderAdapter: (...args: Parameters<typeof real.createSmokeProviderAdapter>) => {
      const adapter = real.createSmokeProviderAdapter(...args)
      if (adapter.id !== 'claude') return adapter
      return {
        ...adapter,
        run: (request: Parameters<typeof adapter.run>[0]) => {
          const handle = adapter.run(request)
          return {
            ...handle,
            promise: handle.promise.then(result => {
              const path = transcriptPath(request.cwd!, result.externalSessionId!)
              appendFileSync(path, nativeLine(request.prompt, request.cwd!))
              return result
            })
          }
        }
      }
    }
  }
})

function nativeLine(prompt: string, cwd: string): string {
  return JSON.stringify({ type: 'user', sessionId, cwd, message: { role: 'user', content: prompt } }) + '\n'
}

afterEach(() => {
  captureGate.wait = undefined
  vi.unstubAllEnvs()
  cleanupTempDirs()
})

it('references each completed Provider turn’s own native bytes across consecutive sends', async () => {
  vi.stubEnv('SCRY_ORCHESTRATION', 'on')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_CONVERSATIONS', '1')
  const root = tempDir()
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  const daemon = await startTestDaemon({ root })
  const sink = daemon.host.orchestrationAuthority!.sink
  const path = transcriptPath(daemon.workspace, sessionId, homedir())
  const history = nativeLine('之前的内容', daemon.workspace)
  const source = { provider: 'claude' as const, nativeSessionId: sessionId, path }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, history)
  const references: string[] = []
  try {
    let start = Buffer.byteLength(history)
    for (const prompt of ['中文新轮次', '另一个中文轮次']) {
      const submitted = await daemon.request({
        op: 'submit', intentId: prompt,
        detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'claude', resume: sessionId, prompt })
      })
      expect(submitted.error).toBeUndefined()
      const runId = submitted.runId as string
      await expect.poll(() => sink.getRun(runId)?.lifecycle, { timeout: 5_000 }).toBe('settled')
      const eventForRun = () => sink.listEvents().find(event => event.runId === runId && event.type === 'run.transcript_referenced')
      const bytes = nativeLine(prompt, daemon.workspace)
      const end = start + Buffer.byteLength(bytes)
      const reference = `transcript:claude:${sessionId}#bytes=${start}-${end},sha256=${sha256Hex(bytes)}`
      await expect.poll(eventForRun, { timeout: 1_500 }).toMatchObject({
        evidence: [reference], payload: { transcript: { status: 'available', quality: 'inferred', value: reference } }
      })
      expect(sink.getTurnByRunId(runId)?.evidence).toContain(reference)
      expect(await resolveTranscriptInterval(source, reference)).toMatchObject({ status: 'available', value: Buffer.from(bytes) })
      expect(JSON.stringify(eventForRun())).not.toContain(prompt)
      references.push(reference)
      start = end
    }
    unlinkSync(path)
    for (const reference of references) {
      expect(await resolveTranscriptInterval(source, reference)).toMatchObject({ status: 'unavailable', omissionReason: 'source_removed' })
    }
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    await daemon.dispose()
  }
}, 30_000)

it('drains a settled run’s pending transcript write before closing SQLite', async () => {
  vi.stubEnv('SCRY_ORCHESTRATION', 'on')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_CONVERSATIONS', '1')
  const root = tempDir()
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  const daemon = await startTestDaemon({ root })
  const authority = daemon.host.orchestrationAuthority!
  const path = transcriptPath(daemon.workspace, sessionId, home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, nativeLine('此前的消息', daemon.workspace))
  let release!: () => void
  captureGate.wait = new Promise(resolve => { release = resolve })
  try {
    const submitted = await daemon.request({
      op: 'submit', intentId: 'shutdown-awaits-transcript',
      detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'claude', resume: sessionId, prompt: '退出前完成的消息' })
    })
    expect(submitted.error).toBeUndefined()
    const id = submitted.runId as string
    await expect.poll(() => authority.sink.getRun(id)?.lifecycle, { timeout: 5_000 }).toBe('settled')
    expect(authority.sink.listEvents().some(event => event.runId === id && event.type === 'run.transcript_referenced')).toBe(false)
    const closing = authority.close()
    const released = setTimeout(release, 500)
    try { await closing } finally { clearTimeout(released); release() }
    const reopened = EventSink.open({ userDataDir: daemon.userDataDir, fullfsync: false })
    try {
      const transcript = reopened.listEvents().find(event => event.runId === id && event.type === 'run.transcript_referenced')
      expect(transcript).toMatchObject({ payload: { transcript: { status: 'available' } } })
    } finally {
      reopened.close()
    }
  } finally {
    release()
    await daemon.dispose()
  }
}, 30_000)

it('omits a transcript whose encoded path collides with another canonical workspace', async () => {
  vi.stubEnv('SCRY_ORCHESTRATION', 'on')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_CONVERSATIONS', '1')
  const root = tempDir()
  const home = join(root, 'home')
  const requested = join(root, '项目-工作区')
  const foreign = join(root, '项目', '工作区')
  for (const dir of [home, requested, foreign, join(root, 'userData')]) mkdirSync(dir, { recursive: true })
  vi.stubEnv('HOME', home)
  const cwd = realpathSync(requested)
  const otherCwd = realpathSync(foreign)
  createRecentFoldersStore(join(root, 'userData')).push(cwd)
  const path = transcriptPath(cwd, sessionId, home)
  expect(transcriptPath(otherCwd, sessionId, home)).toBe(path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, nativeLine('另一个工作区的正文', otherCwd))
  const daemon = await startTestDaemon({ root })
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const submitted = await daemon.request({
      op: 'submit', intentId: 'foreign-native-transcript',
      detail: JSON.stringify({ cwd, providerId: 'claude', resume: sessionId, prompt: '本项目的消息' })
    })
    expect(submitted.error).toBeUndefined()
    const runId = submitted.runId as string
    await expect.poll(() => sink.getRun(runId)?.lifecycle, { timeout: 5_000 }).toBe('settled')
    const findTranscript = () => sink.listEvents().find(event => event.runId === runId && event.type === 'run.transcript_referenced')
    await expect.poll(findTranscript, { timeout: 1_500 }).toMatchObject({
      evidence: [], payload: { transcript: { status: 'unavailable' } }
    })
    expect(findTranscript()?.payload.transcript).not.toHaveProperty('value')
    expect(sink.getTurnByRunId(runId)?.evidence).not.toEqual(expect.arrayContaining([expect.stringMatching(/^transcript:/)]))
  } finally {
    await daemon.dispose()
  }
}, 30_000)
