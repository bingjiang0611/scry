import { open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readArchiveTurnProjection } from './trace-archive-projection'

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

async function read(content: string, expectation: Partial<Parameters<typeof readArchiveTurnProjection>[2]> = {}) {
  root = await mkdtemp(join(tmpdir(), 'scry-projection-'))
  const path = join(root, 'turn.json')
  await writeFile(path, content)
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    return await readArchiveTurnProjection(handle, info.size, {
      cwd, sessionId, providerId: 'claude', runId, ...expectation
    })
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
    expect(turn.events.map(item => item.id)).toEqual(['e2', 'e3'])
    expect(turn.events[1].steer?.prompt).toBe('steer prompt')
  })

  it('never selects an event from text inside an unrelated payload', async () => {
    // The payload below contains a full fake event; only structure may select events.
    const decoy = JSON.stringify({ kind: 'model', stage: 'text', runId, text: 'decoy' })
    const turn = await read(archive([
      event({ id: 'tool', kind: 'tool', stage: 'tool:Bash', outputContent: { storage: 'inline', content: decoy } }),
      event({ id: 'real', text: 'real answer' })
    ]))
    expect(turn.events.map(item => item.id)).toEqual(['real'])
  })

  it('keeps Unicode and long values exact across tokenizer chunk boundaries', async () => {
    const text = `${'a'.repeat(300_000)}🙂汉字\ud83d\ude00${'b'.repeat(300_000)}`
    const turn = await read(archive([event({ text })]))
    expect(turn.events).toHaveLength(1)
    expect(turn.events[0].text).toBe(text)
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
    await expect(read(twoTurns)).rejects.toThrow('exactly one turn')
  })
})
