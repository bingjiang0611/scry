import { appendFileSync, chmodSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunOutputFileStore } from './run-output-file'
import { RunOutputLog } from './run-output-log'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), writeSync: vi.fn(fs.writeSync) }
})
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const roots: string[] = []
afterEach(() => {
  vi.mocked(fsyncSync).mockReset().mockImplementation(realFs.fsyncSync)
  vi.mocked(writeSync).mockReset().mockImplementation(realFs.writeSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-run-output-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

async function all(log: RunOutputLog, runId: string): Promise<string> {
  const chunks: string[] = []
  let cursor = 0
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await log.since(runId, cursor)
    if (page.chunks.length === 0) break
    chunks.push(...page.chunks.map((chunk) => chunk.text))
    cursor = page.cursor
  }
  return chunks.join('')
}

describe('RunOutputFileStore', () => {
  it('replays output beyond the old live-cache limit after restart without truncation', async () => {
    const dir = directory()
    const firstStore = new RunOutputFileStore(dir)
    const first = new RunOutputLog({ store: firstStore })
    const pieces = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')}:${'中😀x'.repeat(1_500)}`)
    for (const text of pieces) {
      first.append('run-large', { kind: 'output', text })
      await first.flush('run-large')
    }
    firstStore.close()

    const secondStore = new RunOutputFileStore(dir)
    const second = new RunOutputLog({ store: secondStore })
    expect(await all(second, 'run-large')).toBe(pieces.join(''))
    expect((await second.since('run-large', 0)).chunks.some((chunk) => chunk.kind === 'truncated')).toBe(false)
    secondStore.close()
  })

  it('persists credential-like output verbatim', async () => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    const log = new RunOutputLog({ store })
    log.append('run-secret', { kind: 'tool_result', text: 'export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET' })
    await log.flush('run-secret')
    store.close()
    const raw = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) =>
      readFileSync(join(dir, name), 'utf8')).join('')
    expect(raw).toContain('export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET')
  })

  it('repairs uncommitted data/index tails before the next append', async () => {
    const dir = directory()
    const firstStore = new RunOutputFileStore(dir)
    firstStore.append({ runId: 'run-tail', at: 1, kind: 'output', text: 'before' })
    firstStore.close()
    const data = readdirSync(dir).find((name) => name.endsWith('.jsonl'))!
    const index = readdirSync(dir).find((name) => name.endsWith('.idx'))!
    appendFileSync(join(dir, data), '{"torn":')
    appendFileSync(join(dir, index), Buffer.from([1, 2, 3]))

    const recovered = new RunOutputFileStore(dir)
    recovered.append({ runId: 'run-tail', at: 2, kind: 'output', text: 'after' })
    const page = recovered.since('run-tail', 0)
    expect(page.chunks.map((chunk) => [chunk.seq, chunk.text])).toEqual([[1, 'before'], [2, 'after']])
    recovered.close()
  })

  it('fails closed when only one half of a run file pair survives', async () => {
    const dir = directory()
    const first = new RunOutputFileStore(dir)
    first.append({ runId: 'run-pair', at: 1, kind: 'output', text: 'kept' })
    first.close()
    const data = readdirSync(dir).find((name) => name.endsWith('.jsonl'))!
    rmSync(join(dir, data))
    const reopened = new RunOutputFileStore(dir)
    expect(() => reopened.since('run-pair', 0)).toThrow('pair_incomplete')
    reopened.close()
  })

  it.each(['idx', 'jsonl'])('does not recreate a missing %s or mutate the surviving file on append', (extension) => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    try {
      store.append({ runId: 'missing-index', at: 1, kind: 'output', text: 'irreplaceable' })
      const survivor = join(dir, readdirSync(dir).find((name) => name.endsWith(extension === 'idx' ? '.jsonl' : '.idx'))!)
      const original = readFileSync(survivor)
      rmSync(join(dir, readdirSync(dir).find((name) => name.endsWith(`.${extension}`))!))
      const files = readdirSync(dir)
      expect(() => store.append({ runId: 'missing-index', at: 2, kind: 'output', text: 'new' })).toThrow('pair_incomplete')
      expect(readFileSync(survivor)).toEqual(original)
      expect(readdirSync(dir)).toEqual(files)
    } finally { store.close() }
  })

  it.each([0, 1, 999_999])('rejects invalid indexed length %i instead of returning a caught-up page', (offset) => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    try {
      store.append({ runId: 'bad-offset', at: 1, kind: 'output', text: 'kept' })
      const index = join(dir, readdirSync(dir).find((name) => name.endsWith('.idx'))!)
      const corrupt = Buffer.alloc(8)
      corrupt.writeBigUInt64BE(BigInt(offset))
      writeFileSync(index, corrupt)
      const data = join(dir, readdirSync(dir).find((name) => name.endsWith('.jsonl'))!)
      const original = readFileSync(data)
      expect(() => store.since('bad-offset', 0)).toThrow()
      expect(() => store.since('bad-offset', 1)).toThrow()
      expect(() => store.append({ runId: 'bad-offset', at: 2, kind: 'output', text: 'new' })).toThrow()
      expect(readFileSync(data)).toEqual(original)
      expect(readFileSync(index)).toEqual(corrupt)
    } finally { store.close() }
  })

  it('round trips maximally JSON-escaped chunks without capture failure', async () => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    try {
      const log = new RunOutputLog({ store })
      const text = '\u0000'.repeat(16 * 1024)
      log.append('escaped', { kind: 'output', text })
      await log.flush('escaped')
      expect(await all(log, 'escaped')).toBe(text)
    } finally { store.close() }
  })

  it.each(['data-fsync', 'index-fsync', 'partial-index'] as const)('does not retry uncertain bodies after %s failure and preserves a gap', async (failure) => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    try {
      const log = new RunOutputLog({ store })
      if (failure === 'partial-index') {
        vi.mocked(writeSync).mockImplementationOnce(realFs.writeSync).mockImplementationOnce((fd, buffer) => {
          // The first index commit tears after three bytes. The data was already fsynced.
          if (typeof buffer === 'string') throw new Error('unexpected_string_write')
          realFs.writeSync(fd, buffer, 0, 3, 0)
          throw new Error('injected_storage_failure')
        })
      } else {
        if (failure === 'index-fsync') vi.mocked(fsyncSync).mockImplementationOnce(realFs.fsyncSync)
        vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('injected_storage_failure') })
      }
      log.append('failure', { kind: 'output', text: 'uncertain-body' })
      await expect(log.flush('failure')).rejects.toThrow('injected_storage_failure')
      log.append('failure', { kind: 'output', text: 'after-recovery' })
      await log.flush('failure')
      const page = await log.since('failure', 0)
      // A failed index fsync may already have committed the body; never write it a second time.
      expect(page.chunks.filter((chunk) => chunk.text === 'uncertain-body')).toHaveLength(failure === 'index-fsync' ? 1 : 0)
      expect(page.chunks.slice(-2).map((chunk) => chunk.kind)).toEqual(['truncated', 'output'])
      expect(page.chunks.at(-1)?.text).toBe('after-recovery')
      expect(page.chunks.map((chunk) => chunk.seq)).toEqual(page.chunks.map((_, index) => index + 1))
    } finally { store.close() }
  })

  it('fails closed on an index that points beyond durable data', async () => {
    const dir = directory()
    const first = new RunOutputFileStore(dir)
    first.append({ runId: 'run-corrupt', at: 1, kind: 'output', text: 'kept' })
    first.close()
    const index = readdirSync(dir).find((name) => name.endsWith('.idx'))!
    const corrupt = Buffer.alloc(8)
    corrupt.writeBigUInt64BE(9_999_999n)
    writeFileSync(join(dir, index), corrupt, { mode: 0o600 })

    const reopened = new RunOutputFileStore(dir)
    expect(() => reopened.append({ runId: 'run-corrupt', at: 2, kind: 'output', text: 'nope' }))
      .toThrow('index_ahead_of_data')
    reopened.close()
  })
})
