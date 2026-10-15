import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile, stat, utimes } from 'node:fs/promises'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTranscriptToTurns, type ParsedTurn } from './normalize'
import { TranscriptFileCache, TRANSCRIPT_CACHE_IDLE_MS, TRANSCRIPT_CACHE_MAX_ENTRIES } from './transcript-file-cache'

const line = (value: Record<string, unknown>): string => JSON.stringify({ timestamp: '2026-10-14T00:00:00.000Z', ...value })
const user = (text: string, extra: Record<string, unknown> = {}): string => line({ type: 'user', promptId: text, message: { content: text }, ...extra })
const assistant = (text: string, id = text): string => line({ type: 'assistant', message: {
  id, model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }
} })
function comparable(turns: ParsedTurn[]) {
  return turns.map(turn => ({ ...turn, items: turn.items.map(({ id: _id, ts: _ts, ...event }) => event) }))
}
function full(content: string): ParsedTurn[] {
  let id = 0
  return parseTranscriptToTurns(content, { runId: 'run', newId: () => `full-${id++}`, now: () => '2026-10-14T00:00:00.000Z' })
}

describe('transcript file cache preserves the whole-document normalization contract', () => {
  let directory: string
  let path: string
  let cache: TranscriptFileCache
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'scry-transcript-cache-'))
    path = join(directory, 'session.jsonl')
    cache = new TranscriptFileCache()
  })
  afterEach(async () => { cache.clear(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })
  const request = () => ({ path, runId: 'run', contextKey: 'claude:profile:/workspace' })
  const check = async () => {
    const result = await cache.read(request())
    expect(comparable(result.turns)).toEqual(comparable(full(await readFile(path, 'utf8'))))
    return result
  }

  it('reuses exact unchanged bytes and parses only an appended suffix', async () => {
    const content = [user('first'), assistant('answer')].join('\n') + '\n'
    await writeFile(path, content)
    const cold = await check()
    expect(cold.cache).toBe('cold')
    expect(cold.parsedBytes).toBe(Buffer.byteLength(content))
    const hit = await check()
    expect(hit.cache).toBe('hit')
    expect(hit.parsedBytes).toBe(0)
    expect(hit.turns).toEqual(cold.turns)
    const extra = [user('second'), assistant('more')].join('\n') + '\n'
    await appendFile(path, extra)
    const incremental = await check()
    expect(incremental.cache).toBe('incremental')
    expect(incremental.parsedBytes).toBe(Buffer.byteLength(extra))
    expect(incremental.turns[0]).toEqual(cold.turns[0])
  })

  it('keeps a valid non-newline tail visible but never commits its usage twice', async () => {
    await writeFile(path, user('first') + '\n' + assistant('tail', 'same-message'))
    await check()
    await check()
    await appendFile(path, '\n' + assistant('repeated', 'same-message') + '\n')
    const result = await check()
    expect(result.cache).toBe('incremental')
    expect(result.turns[0].items.filter(event => event.stage === 'result')).toHaveLength(1)
  })

  it('resumes partial UTF-8/JSON and malformed complete lines without losing the next valid turn', async () => {
    const record = Buffer.from(assistant('你好世界'))
    const split = record.indexOf(Buffer.from('好')) + 1
    await writeFile(path, Buffer.concat([Buffer.from(user('first') + '\n'), record.subarray(0, split)]))
    await check()
    await appendFile(path, Buffer.concat([record.subarray(split), Buffer.from('\n{invalid}\n' + user('next') + '\n')]))
    const result = await check()
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0].items.some(event => event.text === '你好世界')).toBe(true)
  })

  it('retains tool identity, meta suppression and cross-chunk usage deduplication', async () => {
    const records = [
      user('first'),
      line({ type: 'assistant', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'tool-id', name: 'Bash', input: { command: 'echo ok' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-id', content: 'ok', is_error: false }] } }),
      assistant('usage', 'duplicate'), assistant('again', 'duplicate'),
      user('hidden meta', { isMeta: true }), assistant('hidden assistant'),
      user('second'), assistant('visible')
    ]
    await writeFile(path, '')
    for (const record of records) { await appendFile(path, record + '\n'); await check() }
    const result = await check()
    const toolResult = result.turns[0].items.find(event => event.stage === 'tool_result')
    expect(toolResult).toMatchObject({ tool: 'Bash', toolUseId: 'tool-id' })
    expect(result.turns.flatMap(turn => turn.items).some(event => event.text === 'hidden assistant')).toBe(false)
  })

  it('detects an earlier rewrite while growing, not just changes to short head/tail guards', async () => {
    const records = [user('first'), assistant('a'.repeat(500)), user('middle'), assistant('b'.repeat(500))]
    await writeFile(path, records.join('\n') + '\n')
    await check()
    records[2] = user('edited')
    await writeFile(path, records.join('\n') + '\n' + user('new') + '\n')
    const result = await check()
    expect(result.cache).toBe('cold')
    expect(result.turns[1].userText).toBe('edited')
  })

  it('does not trust size/mtime for same-size rewrites, truncation or inode replacement', async () => {
    await writeFile(path, user('first') + '\n' + assistant('answer') + '\n')
    await check()
    const before = await stat(path)
    const rewritten = (await readFile(path, 'utf8')).replace('answer', 'edited')
    await writeFile(path, rewritten)
    await utimes(path, before.atime, before.mtime)
    expect((await check()).cache).toBe('cold')
    await writeFile(path, user('short') + '\n')
    expect((await check()).cache).toBe('cold')
    const replacement = join(directory, 'replacement')
    await writeFile(replacement, await readFile(path))
    await rename(replacement, path)
    expect((await check()).cache).toBe('cold')
  })

  it('isolates returned/enriched objects and coalesces simultaneous reads', async () => {
    await writeFile(path, user('first') + '\n' + assistant('answer') + '\n')
    const [first, second] = await Promise.all([cache.read(request()), cache.read(request())])
    expect(first.turns).toEqual(second.turns)
    expect(first.turns).not.toBe(second.turns)
    first.turns[0].items.length = 0
    first.turns[0].userText = 'caller mutation'
    expect((await check()).turns[0].userText).toBe('first')
    expect(second.turns[0].items.length).toBeGreaterThan(0)
  })

  it('partitions profiles and run IDs, evicts LRU entries and expires idle snapshots', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await writeFile(path, user('first') + '\n')
    await cache.read(request())
    expect((await cache.read({ ...request(), contextKey: 'different-profile' })).cache).toBe('cold')
    expect((await cache.read({ ...request(), runId: 'other-run' })).turns[0].items.every(event => event.runId === 'other-run')).toBe(true)
    for (let index = 0; index < TRANSCRIPT_CACHE_MAX_ENTRIES; index++) {
      await cache.read({ ...request(), contextKey: `profile-${index}` })
    }
    expect((await cache.read(request())).cache).toBe('cold')
    vi.advanceTimersByTime(TRANSCRIPT_CACHE_IDLE_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect((await cache.read(request())).cache).toBe('cold')
  })

  it('rejects a source that changes during the read instead of caching a partial success', async () => {
    await writeFile(path, user('first') + '\n')
    const actualOpen = vi.mocked(open).getMockImplementation()!
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args)
      const read = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementationOnce(async () => {
        const buffer = await read()
        await appendFile(path, user('concurrent') + '\n')
        return buffer
      })
      return handle
    })
    await expect(cache.read(request())).rejects.toThrow('transcript_changed_during_read')
    expect((await check()).cache).toBe('cold')
  })

  it('does not return deleted source evidence or a canceled read as an empty success', async () => {
    await writeFile(path, user('first') + '\n')
    await check()
    await rm(path)
    await expect(cache.read(request())).rejects.toMatchObject({ code: 'ENOENT' })
    const controller = new AbortController()
    controller.abort(new Error('selection changed'))
    await expect(cache.read({ ...request(), signal: controller.signal })).rejects.toThrow('selection changed')
  })
})
