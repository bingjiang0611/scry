import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerformanceJournal, performanceEnvironment, type PerformanceEnvironment, type PerformanceObservation } from './performance-journal'
import { performanceBuildId } from './performance-build-id'

const environment: PerformanceEnvironment = { version: 'test', build: 'fixture', mode: 'development', platform: 'test', osRelease: 'test', arch: 'test', cpu: 'test', runtime: 'test' }
const observation: PerformanceObservation = { kind: 'trace', sample: {
  name: 'ipc.workspace:read', durationMs: 10, outcome: 'completed', startedAt: '2026-01-01T00:00:00.000Z', dimensions: {}, checkpoints: []
} }
const temporary: string[] = []
const journals: PerformanceJournal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close()
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'scry-performance-test-'))
  temporary.push(path)
  return path
}

describe('local performance journal', () => {
  it('flushes real files, rotates within limits, and preserves restart/version evidence', async () => {
    const path = await directory()
    const onError = vi.fn()
    const journal = new PerformanceJournal({ directory: path, environment, maxFileBytes: 900, onError })
    journals.push(journal)
    await journal.open()
    for (let index = 0; index < 20; index++) journal.record(observation)
    await journal.close()
    const files = await readdir(path)
    expect(files).toHaveLength(4)
    for (const file of files) expect((await stat(join(path, file))).size).toBeLessThanOrEqual(900)
    const retained = (await Promise.all(files.map(file => readFile(join(path, file), 'utf8')))).join('').trim().split('\n').map(line => JSON.parse(line))
    expect(retained.some(record => JSON.stringify(record.observation) === JSON.stringify(observation))).toBe(true)
    const first = JSON.parse((await readFile(join(path, 'performance-0.jsonl'), 'utf8')).trim().split('\n')[0])
    expect(first).toMatchObject({ schema: 1, version: 'test', build: 'fixture' })
    expect(JSON.stringify(first)).not.toContain(path)
    const next = new PerformanceJournal({ directory: path, environment: { ...environment, build: 'next' }, maxFileBytes: 900, onError })
    journals.push(next)
    await next.open()
    next.record(observation)
    await next.close()
    const records = (await readFile(join(path, 'performance-0.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records.at(-1).build).toBe('next')
    expect(records.at(-1).session).not.toBe(first.session)
    expect(onError).not.toHaveBeenCalled()
  })

  it('bounds pending memory and exposes dropped observations instead of claiming full coverage', async () => {
    const journal = new PerformanceJournal({ directory: await directory(), environment, maxQueueBytes: 900, onError: vi.fn() })
    journals.push(journal)
    await journal.open()
    for (let index = 0; index < 100; index++) journal.record(observation)
    expect(journal.status.queuedBytes).toBeLessThanOrEqual(900)
    expect(journal.status.dropped).toBeGreaterThan(0)
    await journal.flush()
    expect(journal.status.queuedBytes).toBe(0)
  })

  it('fails open once on an actual filesystem write failure and drains concurrent final records', async () => {
    const path = await directory()
    const onError = vi.fn()
    const journal = new PerformanceJournal({ directory: path, environment, onError })
    journals.push(journal)
    await journal.open()
    journal.record(observation)
    const flush = journal.flush()
    journal.record(observation)
    await journal.close()
    await flush
    const records = (await readFile(join(path, 'performance-0.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records.filter(record => record.observation.kind === 'trace')).toHaveLength(2)
    expect(records.at(-1).observation).toEqual({ kind: 'health', sample: { droppedRecords: 0, closed: true } })
    const broken = new PerformanceJournal({ directory: path, environment, onError })
    journals.push(broken)
    await broken.open()
    await rm(path, { recursive: true })
    broken.record(observation)
    await broken.flush()
    broken.record(observation)
    await broken.flush()
    expect(broken.status.failed).toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('isolates a crash-truncated tail instead of concatenating new JSON to it', async () => {
    const path = await directory()
    await writeFile(join(path, 'performance-0.jsonl'), '{"schema":1,')
    const journal = new PerformanceJournal({ directory: path, environment, onError: vi.fn() })
    journals.push(journal)
    await journal.open()
    journal.record(observation)
    await journal.close()
    expect(await readFile(join(path, 'performance-1.jsonl'), 'utf8')).toBe('{"schema":1,')
    const records = (await readFile(join(path, 'performance-0.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0].observation).toEqual(observation)
  })

  it('fingerprints all build source surfaces, not just the unchanged package version', async () => {
    const root = await directory()
    for (const surface of ['main', 'preload', 'renderer']) {
      await mkdir(join(root, 'src', surface), { recursive: true })
      await writeFile(join(root, 'src', surface, 'index.ts'), 'first build')
    }
    for (const file of ['package.json', 'package-lock.json', 'electron.vite.config.ts']) await writeFile(join(root, file), '{}')
    const first = performanceEnvironment('1', performanceBuildId(root), false)
    await writeFile(join(root, 'src/renderer/index.ts'), 'renderer-only change')
    const second = performanceEnvironment('1', performanceBuildId(root), false)
    expect(second.build).not.toBe(first.build)
    expect(JSON.stringify(second)).not.toContain(root)
  })
})
