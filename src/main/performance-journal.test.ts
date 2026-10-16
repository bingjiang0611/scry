import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
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
const archiveName = /^performance-\d{8}T\d{9}Z-[0-9a-f]{8}\.jsonl\.gz$/
const fileText = async (path: string): Promise<string> => {
  const bytes = await readFile(path)
  return path.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
}
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
    // One active file plus compressed archives; nothing rotated away within the archive cap.
    expect(files).toContain('performance-0.jsonl')
    const archives = files.filter(file => file !== 'performance-0.jsonl')
    expect(archives.length).toBeGreaterThan(1)
    for (const file of archives) expect(file).toMatch(archiveName)
    for (const file of files) expect(Buffer.byteLength(await fileText(join(path, file)))).toBeLessThanOrEqual(900)
    for (const file of files) expect((await stat(join(path, file))).mode & 0o777).toBe(0o600)
    const retained = (await Promise.all(files.map(file => fileText(join(path, file))))).join('').trim().split('\n').map(line => JSON.parse(line))
    expect(retained.filter(record => JSON.stringify(record.observation) === JSON.stringify(observation))).toHaveLength(20)
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
    const archives = (await readdir(path)).filter(file => file !== 'performance-0.jsonl')
    expect(archives).toHaveLength(1)
    expect(await fileText(join(path, archives[0]))).toBe('{"schema":1,')
    const records = (await readFile(join(path, 'performance-0.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0].observation).toEqual(observation)
  })

  it('keeps compressed archives within the byte cap by deleting the oldest first', async () => {
    const path = await directory()
    const old = ['performance-20260101T000000000Z-00000001.jsonl.gz', 'performance-20260102T000000000Z-00000002.jsonl.gz', 'performance-20260103T000000000Z-00000003.jsonl.gz']
    for (const [index, name] of old.entries()) await writeFile(join(path, name), gzipSync(`${JSON.stringify({ archive: index })}\n`.repeat(200)))
    const sizes = await Promise.all(old.map(async name => (await stat(join(path, name))).size))
    const cap = sizes[1] + sizes[2]
    const journal = new PerformanceJournal({ directory: path, environment, maxArchiveBytes: cap, onError: vi.fn() })
    journals.push(journal)
    await journal.open()
    await journal.close()
    expect((await readdir(path)).sort()).toEqual([...old.slice(1), 'performance-0.jsonl'].sort())
  })

  it('migrates the pre-archive layout and finishes an interrupted compression', async () => {
    const path = await directory()
    await writeFile(join(path, 'performance-0.jsonl'), '{"active":true}\n')
    for (const index of [1, 2, 3]) {
      await writeFile(join(path, `performance-${index}.jsonl`), `{"legacy":${index}}\n`)
      // Older rotated files stopped growing earlier, so their archive stamps sort first.
      const time = new Date(Date.UTC(2026, 0, 10 - index))
      await utimes(join(path, `performance-${index}.jsonl`), time, time)
    }
    // A crash after rename but before compression leaves a plain stamped archive and a partial gzip.
    await writeFile(join(path, 'performance-20260120T000000000Z-0000000a.jsonl'), '{"interrupted":true}\n')
    await writeFile(join(path, 'performance-20260120T000000000Z-0000000a.jsonl.gz.partial'), 'broken')
    const onError = vi.fn()
    const journal = new PerformanceJournal({ directory: path, environment, onError })
    journals.push(journal)
    await journal.open()
    await journal.close()
    const files = (await readdir(path)).sort()
    const archives = files.filter(file => file !== 'performance-0.jsonl')
    expect(archives).toHaveLength(4)
    for (const file of archives) expect(file).toMatch(archiveName)
    expect(await Promise.all(archives.map(file => fileText(join(path, file))))).toEqual(['{"legacy":3}\n', '{"legacy":2}\n', '{"legacy":1}\n', '{"interrupted":true}\n'])
    expect((await fileText(join(path, 'performance-0.jsonl'))).startsWith('{"active":true}\n')).toBe(true)
    expect(onError).not.toHaveBeenCalled()
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
