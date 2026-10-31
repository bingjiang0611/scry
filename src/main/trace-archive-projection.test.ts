import { open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { iterateArchiveEntries, type ArchiveEntry, type ArchiveReadEvidence } from './trace-archive-projection'

/** Assembles the streamed entries of one file into the turns the assertions speak about. */
async function collect(entries: AsyncIterable<ArchiveEntry>): Promise<Array<{
  runId: string; done: boolean; status?: string; userText: string;
  events: Array<{ kind: 'text'; text: string; stage: string } | { kind: 'steer'; status: string; prompt: string; messageId?: string }>;
  breaks: number
}>> {
  const turns: Array<ReturnType<typeof emptyTurn>> = []
  let current: ReturnType<typeof emptyTurn> | undefined
  let open: { event: number; text: string } | undefined
  const flush = (): void => {
    if (current && open) current.events.push({ kind: 'text', text: open.text, stage: 'text' })
    open = undefined
  }
  const emptyTurn = (): { runId: string; done: boolean; status?: string; userText: string;
    events: Array<{ kind: 'text'; text: string; stage: string } | { kind: 'steer'; status: string; prompt: string; messageId?: string }>;
    breaks: number } => ({ runId: '', done: false, userText: '', events: [], breaks: 0 })
  for await (const entry of entries) {
    if (!current) current = emptyTurn()
    if (entry.type === 'turn') {
      flush()
      current = { ...current, runId: entry.runId, done: entry.done, ...(entry.status ? { status: entry.status } : {}) }
      turns.push(current)
      current = undefined
      continue
    }
    if (entry.type === 'user') {
      current.userText += entry.chunk
      continue
    }
    if (entry.type === 'break') {
      flush()
      current.breaks += 1
      continue
    }
    if (entry.type === 'steer') {
      flush()
      const steer = current.events.at(-1)
      if (steer?.kind === 'steer') steer.prompt += entry.chunk
      else current.events.push({ kind: 'steer', status: entry.status, prompt: entry.chunk })
      continue
    }
    if (entry.type === 'body') continue
    if (open?.event !== entry.event) flush()
    open = { event: entry.event, text: (open?.text ?? '') + entry.chunk }
  }
  flush()
  return turns
}

const cwd = '/tmp/workspace'
const sessionId = 'session-1'
const runId = 'run-1'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

function archive(items: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3, cwd, sessionId, providerId: 'claude',
    turns: [{ runId, userText: 'question', ts: 1, done: true, status: 'completed', items: [...items], ...overrides }]
  })
}

async function read(content: string, expectation: { providerId?: string; enforceRun?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), 'scry-projection-'))
  const path = join(root, 'turn.json')
  await writeFile(path, content)
  const handle = await open(path, 'r')
  const evidence: ArchiveReadEvidence = { bytesRead: 0, digest: '' }
  try {
    const info = await handle.stat()
    const turns = []
    const streamed = iterateArchiveEntries(handle, info.size, {
      cwd, sessionId, turnCount: 'single', providerId: expectation.providerId ?? 'claude',
      ...(expectation.enforceRun === false ? {} : { runId })
    }, evidence)
    turns.push(...await collect(streamed))
    expect(evidence.bytesRead).toBe(info.size)
    expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(turns).toHaveLength(1)
    return turns[0]
  } finally {
    await handle.close()
  }
}

const event = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'e1', ts: '2026-01-01T00:00:00.000Z', runId, kind: 'model', stage: 'text', text: 'answer', ...overrides
})

describe('readArchiveTurnProjection', () => {
  it('projects visible text and steer evidence, skipping tool payloads', async () => {
    const turn = await read(archive([
      event({ stage: 'tool:Bash', kind: 'tool', outputContent: { storage: 'inline', content: 'x'.repeat(2_000_000) } }),
      event({ id: 'e2', text: 'visible answer' }),
      event({ id: 'e3', stage: 'steer', steer: { status: 'accepted', messageId: 'm1', prompt: 'steer prompt' } }),
      event({ id: 'e4', agentId: 'subagent', text: 'subagent text' }),
      event({ id: 'e5', stage: 'thinking', kind: 'model', text: 'reasoning' })
    ]))
    expect(turn.userText).toBe('question')
    expect(turn.done).toBe(true)
    expect(turn.status).toBe('completed')
    expect(turn.events.map(item => item.kind)).toEqual(['text', 'steer'])
    expect(turn.events[0]).toMatchObject({ kind: 'text', text: 'visible answer' })
    expect(turn.events[1]).toMatchObject({ kind: 'steer', prompt: 'steer prompt', status: 'accepted' })
  })

  it('never selects an event from text inside an unrelated payload', async () => {
    // The payload below contains a full fake event; only structure may select events.
    const decoy = JSON.stringify({ kind: 'model', stage: 'text', runId, text: 'decoy' })
    const turn = await read(archive([
      event({ id: 'tool', kind: 'tool', stage: 'tool:Bash', outputContent: { storage: 'inline', content: decoy } }),
      event({ id: 'real', text: 'real answer' })
    ]))
    expect(turn.events).toEqual([{ kind: 'text', text: 'real answer', stage: 'text' }])
  })

  it('keeps Unicode and long values exact across tokenizer chunk boundaries', async () => {
    const text = `${'a'.repeat(300_000)}🙂汉字\ud83d\ude00${'b'.repeat(300_000)}`
    const turn = await read(archive([event({ text })]))
    expect(turn.events).toHaveLength(1)
    expect(turn.events[0]).toMatchObject({ kind: 'text', text })
  })

  it('fails closed on truncated, re-identified and re-run files', async () => {
    await expect(read(archive([event({})]).slice(0, 120))).rejects.toThrow(/corrupt or truncated/)
    const file = archive([event({})])
    await expect(read(file.replace('"cwd":"/tmp/workspace"', '"cwd":"/tmp/other"'))).rejects.toThrow('workspace')
    await expect(read(file.replace(`"runId":"${runId}"`, '"runId":"run-2"'))).rejects.toThrow('another run')
    await expect(read(file.replace('"providerId":"claude"', '"providerId":"codex"'))).rejects.toThrow('Provider')
    await expect(read(file, { providerId: 'codex' })).rejects.toThrow('Provider')
  })

  it('refuses an event that claims another Provider or run', async () => {
    await expect(read(archive([event({ providerId: 'codex' })]))).rejects.toThrow('Provider')
    await expect(read(archive([event({ runId: 'other-run' })]))).rejects.toThrow('another run')
  })

  it('refuses a segment with more than one turn', async () => {
    const twoTurns = JSON.stringify({
      version: 3, cwd, sessionId, providerId: 'claude',
      turns: [{ runId, userText: 'q', ts: 1, done: true, items: [] }, { runId: 'run-2', userText: 'q2', ts: 2, done: true, items: [] }]
    })
    await expect(read(twoTurns, { enforceRun: false })).rejects.toThrow('exactly one turn')
  })
})
