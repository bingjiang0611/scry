import { mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_EVENT_LOG_LIMITS,
  PROVIDER_EVENT_LOG_ENV,
  ProviderEventLog,
  sanitizeEventRecord
} from './provider-event-log'

const root = async (): Promise<string> => mkdtemp(join(tmpdir(), 'scry-event-log-'))

const readLines = async (dir: string, thread: string): Promise<Array<Record<string, unknown>>> => {
  const threadDir = join(dir, thread)
  const files = (await readdir(threadDir)).filter((name) => name.endsWith('.ndjson')).sort()
  const lines: Array<Record<string, unknown>> = []
  for (const file of files) {
    const content = await readFile(join(threadDir, file), 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return lines
}

describe('记录级上限', () => {
  it('截断超长字符串、超量字段和过深结构，并标记 truncated', () => {
    const limits = { ...DEFAULT_PROVIDER_EVENT_LOG_LIMITS, maxValueChars: 10, maxFields: 2, maxDepth: 3 }
    const long = sanitizeEventRecord({ text: 'x'.repeat(25) }, limits)
    expect(long.truncated).toBe(true)
    expect((long.value as { text: string }).text).toBe(`${'x'.repeat(10)}…[+15 chars]`)

    const wide = sanitizeEventRecord({ a: 1, b: 2, c: 3, d: 4 }, limits)
    expect(wide.truncated).toBe(true)
    expect(wide.value).toEqual({ a: 1, b: 2, __droppedFields: 2 })

    const deep = sanitizeEventRecord({ a: { b: { c: { d: { e: 1 } } } } }, limits)
    expect(deep.truncated).toBe(true)
    expect(JSON.stringify(deep.value)).toContain('depth-limited')

    const wideArray = sanitizeEventRecord([1, 2, 3, 4, 5], limits)
    expect(wideArray.value).toEqual([1, 2, '[+3 items]'])
  })

  it('默认上限就是约定的 65536 字符 / 1024 字段 / 深度 16，缓冲为 1MB 或 512 条', () => {
    expect(DEFAULT_PROVIDER_EVENT_LOG_LIMITS).toMatchObject({
      maxValueChars: 65_536,
      maxFields: 1_024,
      maxDepth: 16,
      flushBytes: 1_048_576,
      flushRecords: 512,
      maxFileBytes: 10 * 1024 * 1024,
      maxFiles: 10,
      maxTotalBytes: 512 * 1024 * 1024,
      retentionMs: 14 * 24 * 60 * 60 * 1_000,
      sweepIntervalMs: 5 * 60 * 1_000
    })
  })

  it('环状引用不会让序列化崩溃', () => {
    const cycle: Record<string, unknown> = { name: 'root' }
    cycle.self = cycle
    const sanitized = sanitizeEventRecord(cycle)
    expect(sanitized.truncated).toBe(true)
    expect(() => JSON.stringify(sanitized.value)).not.toThrow()
  })
})

describe('双流写入', () => {
  it('native 与 canonical 共享同一 writer、同一文件和递增序号', async () => {
    const dir = await root()
    const log = new ProviderEventLog({ root: dir })
    const writer = log.writer('claude-run-1')
    writer.record('native', 'assistant', { type: 'assistant', message: { content: 'hi' } })
    writer.record('canonical', 'model/text', { kind: 'model', stage: 'text', text: 'hi' })
    const summary = await writer.close()

    expect(summary.failed).toBe(false)
    const lines = await readLines(dir, 'claude-run-1')
    expect(lines.map((line) => line.stream)).toEqual(['native', 'canonical', 'log'])
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3])
    expect(summary).toMatchObject({ written: 2, transientSkipped: 0, truncated: 0 })
    expect(lines[2]).toMatchObject({ type: 'summary', payload: { written: 2, transientSkipped: 0 } })
  })

  it('瞬时事件不落盘，但在摘要里有计数', async () => {
    const dir = await root()
    const log = new ProviderEventLog({ root: dir })
    const writer = log.writer('claude-run-2')
    writer.record('native', 'stream_event', { delta: 'a' })
    writer.record('canonical', 'model/text_delta', { text: 'a' })
    writer.record('canonical', 'model/text', { text: 'a' })
    const summary = await writer.close()

    expect(summary.transientSkipped).toBe(2)
    const lines = await readLines(dir, 'claude-run-2')
    expect(lines.filter((line) => line.stream !== 'log').map((line) => line.type)).toEqual(['model/text'])
    expect(lines.at(-1)).toMatchObject({ payload: { transientSkipped: 2, written: 1 } })
  })

  it('线程名被规整，不会逃出日志根目录', async () => {
    const dir = await root()
    const writer = new ProviderEventLog({ root: dir }).writer('../../escape/run 1')
    writer.record('native', 'x', {})
    await writer.close()
    expect(await readdir(dir)).toEqual(['.._.._escape_run_1'])
  })

  it('超过单文件上限时切换分片', async () => {
    const dir = await root()
    const log = new ProviderEventLog({ root: dir, limits: { maxFileBytes: 512, flushRecords: 1 } })
    const writer = log.writer('rotating')
    for (let index = 0; index < 12; index += 1) {
      writer.record('native', 'chunk', { index, filler: 'y'.repeat(200) })
      await writer.flush()
    }
    await writer.close()
    const files = (await readdir(join(dir, 'rotating'))).sort()
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      const info = await stat(join(dir, 'rotating', file))
      // 分片在越过上限的那条记录之前切换，所以每个分片最多超出一条记录的大小。
      expect(info.size).toBeLessThan(512 + 512)
    }
  })

  it('写入失败只停用日志，调用方拿到 failed 摘要而不是异常', async () => {
    const dir = await root()
    // 把线程目录占成一个文件：mkdir 必然失败。
    await mkdir(join(dir), { recursive: true })
    await writeFile(join(dir, 'blocked'), 'not a directory')
    const writer = new ProviderEventLog({ root: dir }).writer('blocked')
    expect(() => writer.record('native', 'x', { a: 1 })).not.toThrow()
    const summary = await writer.close()
    expect(summary.failed).toBe(true)
  })
})

describe('保留与清理', () => {
  it('按保留期、分片数与总量回收旧分片', async () => {
    const dir = await root()
    const now = Date.UTC(2026, 0, 30)
    const log = new ProviderEventLog({
      root: dir,
      now: () => now,
      limits: { retentionMs: 1_000, maxFiles: 10, maxTotalBytes: 512 * 1024 * 1024 }
    })
    const threadDir = join(dir, 'old-thread')
    await mkdir(threadDir, { recursive: true })
    const stale = join(threadDir, 'events-000.ndjson')
    const fresh = join(threadDir, 'events-001.ndjson')
    await writeFile(stale, '{}\n')
    await writeFile(fresh, '{}\n')
    const staleSeconds = (now - 10_000) / 1000
    await utimes(stale, staleSeconds, staleSeconds)
    await utimes(fresh, now / 1000, now / 1000)

    await log.sweep(true)
    expect(await readdir(threadDir)).toEqual(['events-001.ndjson'])
  })

  it('分片数超过上限时只保留最新的若干个', async () => {
    const dir = await root()
    const now = Date.UTC(2026, 0, 30)
    const log = new ProviderEventLog({ root: dir, now: () => now, limits: { maxFiles: 2, retentionMs: 10 ** 9 } })
    const threadDir = join(dir, 'many')
    await mkdir(threadDir, { recursive: true })
    for (let index = 0; index < 4; index += 1) {
      const path = join(threadDir, `events-00${index}.ndjson`)
      await writeFile(path, '{}\n')
      const seconds = (now - (4 - index) * 1_000) / 1000
      await utimes(path, seconds, seconds)
    }
    await log.sweep(true)
    expect((await readdir(threadDir)).sort()).toEqual(['events-002.ndjson', 'events-003.ndjson'])
  })

  it('总量超限时丢弃最旧的分片', async () => {
    const dir = await root()
    const now = Date.UTC(2026, 0, 30)
    const log = new ProviderEventLog({ root: dir, now: () => now, limits: { maxTotalBytes: 20, retentionMs: 10 ** 9 } })
    const threadDir = join(dir, 'bulky')
    await mkdir(threadDir, { recursive: true })
    for (let index = 0; index < 3; index += 1) {
      const path = join(threadDir, `events-00${index}.ndjson`)
      await writeFile(path, 'x'.repeat(15))
      const seconds = (now - (3 - index) * 1_000) / 1000
      await utimes(path, seconds, seconds)
    }
    await log.sweep(true)
    expect(await readdir(threadDir)).toEqual(['events-002.ndjson'])
  })
})

describe('环境变量门控', () => {
  it('默认关闭，只接受 1 或绝对路径', () => {
    expect(ProviderEventLog.fromEnvironment({}, '/userData')).toBeNull()
    expect(ProviderEventLog.fromEnvironment({ [PROVIDER_EVENT_LOG_ENV]: '0' }, '/userData')).toBeNull()
    expect(ProviderEventLog.fromEnvironment({ [PROVIDER_EVENT_LOG_ENV]: 'true' }, '/userData')).toBeNull()
    expect(ProviderEventLog.fromEnvironment({ [PROVIDER_EVENT_LOG_ENV]: 'relative/dir' }, '/userData')).toBeNull()
    expect(ProviderEventLog.fromEnvironment({ [PROVIDER_EVENT_LOG_ENV]: '1' }, '/userData')?.root)
      .toBe('/userData/provider-event-log')
    expect(ProviderEventLog.fromEnvironment({ [PROVIDER_EVENT_LOG_ENV]: '/tmp/scry-logs' }, '/userData')?.root)
      .toBe('/tmp/scry-logs')
  })
})
