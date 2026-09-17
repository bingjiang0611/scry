import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunOutputFileStore } from './run-output-file'
import { RunOutputLog } from './run-output-log'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-run-output-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function all(log: RunOutputLog, runId: string): string {
  const chunks: string[] = []
  let cursor = 0
  for (let guard = 0; guard < 10_000; guard++) {
    const page = log.since(runId, cursor)
    if (page.chunks.length === 0) break
    chunks.push(...page.chunks.map((chunk) => chunk.text))
    cursor = page.cursor
  }
  return chunks.join('')
}

describe('RunOutputFileStore', () => {
  it('replays output beyond the old live-cache limit after restart without truncation', () => {
    const dir = directory()
    const firstStore = new RunOutputFileStore(dir)
    const first = new RunOutputLog({ store: firstStore })
    const pieces = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')}:${'中😀x'.repeat(1_500)}`)
    for (const text of pieces) first.append('run-large', { kind: 'output', text })
    first.flush('run-large')
    firstStore.close()

    const secondStore = new RunOutputFileStore(dir)
    const second = new RunOutputLog({ store: secondStore })
    expect(all(second, 'run-large')).toBe(pieces.join(''))
    expect(second.since('run-large', 0).chunks.some((chunk) => chunk.kind === 'truncated')).toBe(false)
    secondStore.close()
  })

  it('persists only secret-masked content', () => {
    const dir = directory()
    const store = new RunOutputFileStore(dir)
    const log = new RunOutputLog({ store })
    log.append('run-secret', { kind: 'tool_result', text: 'export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET' })
    log.flush('run-secret')
    store.close()
    const raw = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) =>
      readFileSync(join(dir, name), 'utf8')).join('')
    expect(raw).not.toContain('SECRETSECRETSECRETSECRET')
  })

  it('repairs uncommitted data/index tails before the next append', () => {
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

  it('fails closed when only one half of a run file pair survives', () => {
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

  it('fails closed on an index that points beyond durable data', () => {
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
