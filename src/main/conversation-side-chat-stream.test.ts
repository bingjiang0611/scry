import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamTurns } from './conversation-side-chat-stream'
import type { ArchiveEntry } from './trace-archive-projection'

/**
 * Every spill directory this test file created, so "was it freed" is a statement about
 * those directories instead of a count that parallel test files could perturb.
 */
const spills = vi.hoisted(() => ({ created: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
    const directory = await actual.mkdtemp(...args)
    if (String(args[0]).includes('scry-spool-')) spills.created.push(directory)
    return directory
  } }
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  spills.created.length = 0
})

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

async function workspace(): Promise<{ userData: string; cwd: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'scry-stream-fixture-'))
  directories.push(directory)
  return { userData: join(directory, 'userData'), cwd: join(directory, 'project') }
}

/** One archive turn: prompt, visible answer, then the header that closes it. */
function turnEntries(turn: number, question: string, answer: string): ArchiveEntry[] {
  return [
    { type: 'user', turn, chunk: question },
    { type: 'text', turn, event: 1, stage: 'text', messageId: `m${turn}`, chunk: answer },
    { type: 'turn', turn, runId: `run-${turn}`, ts: 1_760_000_000_000 + turn, done: true, status: 'completed' }
  ]
}

async function* from(entries: readonly ArchiveEntry[]): AsyncGenerator<ArchiveEntry> {
  for (const entry of entries) yield entry
}

const readTurn = async (turn: { messages: ReadonlyArray<{ text: AsyncIterable<string> }> }): Promise<string[]> => {
  const texts: string[] = []
  for (const message of turn.messages) {
    let text = ''
    for await (const chunk of message.text) text += chunk
    texts.push(text)
  }
  return texts
}

/** Spill directories recorded during this test that still exist. */
async function leftovers(): Promise<string[]> {
  const remaining: string[] = []
  for (const directory of spills.created) {
    const exists = await stat(directory).then(() => true, () => false)
    if (exists) remaining.push(directory)
  }
  return remaining
}

describe('archive-backed side-chat streaming', () => {
  it('returns the whole budget and frees every spill once each turn has been consumed', async () => {
    const { userData, cwd } = await workspace()
    // Two 5 KiB bodies per turn against an 8 KiB allowance: once one body is charged the
    // next cannot fit and spills, so a run that keeps its inputs would spend the allowance
    // on turn one and spill everything after it.
    const body = 'b'.repeat(5 * 1024)
    const entries = Array.from({ length: 60 }, (_unused, index) =>
      turnEntries(index + 1, `question ${index} ${body}`, `answer ${index} ${body}`)).flat()
    const budget = { available: 8 * 1024 }
    const seen: string[][] = []
    for await (const turn of streamTurns(userData, cwd, from(entries), budget)) seen.push(await readTurn(turn))

    expect(seen).toHaveLength(60)
    expect(seen[0][0]).toContain('question 0')
    expect(Buffer.byteLength(seen[59][1], 'utf8')).toBe(`answer 59 ${body}`.length)
    expect(digest(seen[59][1])).toBe(digest(`answer 59 ${body}`))
    // The allowance is the shared authority: a turn that kept its input spools would leave
    // its charge behind and the running total would never come back.
    expect(budget.available).toBe(8 * 1024)
    // Spills really happened (the fixture is far larger than the allowance), and none of
    // those directories, handles or budget charges survived the turn that used them.
    expect(spills.created.length).toBeGreaterThan(0)
    expect(await leftovers()).toEqual([])
  })

  it('frees the turn in flight when the caller abandons the generator', async () => {
    const { userData, cwd } = await workspace()
    const body = 'c'.repeat(5 * 1024)
    const entries = Array.from({ length: 4 }, (_unused, index) =>
      turnEntries(index + 1, `question ${index} ${body}`, `answer ${index} ${body}`)).flat()
    const budget = { available: 8 * 1024 }
    const iterator = streamTurns(userData, cwd, from(entries), budget)
    // Two finished turns first: their storage must already be back before the abandonment,
    // otherwise only the turn still in flight is ever freed.
    for (let index = 0; index < 2; index += 1) {
      const next = await iterator.next()
      expect(next.done).toBe(false)
      if (!next.done) await readTurn(next.value)
    }
    await iterator.return?.(undefined as never)

    expect(budget.available).toBe(8 * 1024)
    expect(spills.created.length).toBeGreaterThan(0)
    expect(await leftovers()).toEqual([])
  })

  it('frees the turn in flight when the archive stream throws', async () => {
    const { userData, cwd } = await workspace()
    const body = 'd'.repeat(5 * 1024)
    const entries = Array.from({ length: 3 }, (_unused, index) =>
      turnEntries(index + 1, `question ${index} ${body}`, `answer ${index} ${body}`)).flat()
    const budget = { available: 8 * 1024 }
    const failing = async function* (): AsyncGenerator<ArchiveEntry> {
      let index = 0
      for (const entry of entries) {
        yield entry
        index += 1
        if (index === entries.length - 2) throw new Error('archive read failed')
      }
    }
    const iterator = streamTurns(userData, cwd, failing(), budget)
    await expect((async () => {
      for await (const turn of iterator) await readTurn(turn)
    })()).rejects.toThrow('archive read failed')

    expect(budget.available).toBe(8 * 1024)
    expect(spills.created.length).toBeGreaterThan(0)
    expect(await leftovers()).toEqual([])
  })
})
