import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { streamNativeTranscriptTurns } from './conversation-side-chat-native-stream'
import type { StreamedTurn } from './conversation-side-chat-stream'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function transcript(lines: readonly string[], trailing = ''): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scry-native-stream-'))
  directories.push(directory)
  const path = join(directory, 'session.jsonl')
  await writeFile(path, lines.join('') + trailing)
  return path
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Claude settles a turn only with its own terminal marker. */
const settles = (stopReason: string | undefined): boolean => stopReason === 'end_turn'

function claudeUser(text: string, promptId?: string): string {
  return `${JSON.stringify({
    type: 'user', sessionId: 'native-1', cwd: '/project', ...(promptId ? { promptId } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] }
  })}\n`
}

function claudeAssistant(text: string, stopReason = 'end_turn'): string {
  return `${JSON.stringify({
    type: 'assistant', sessionId: 'native-1', cwd: '/project',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason }
  })}\n`
}

async function collect(path: string, identity: { sessionId?: string; cwd?: string } = {}):
Promise<{ turns: Array<StreamedTurn & { texts: string[] }>; largest: number }> {
  const turns: Array<StreamedTurn & { texts: string[] }> = []
  let largest = 0
  for await (const turn of streamNativeTranscriptTurns({
    path, runId: 'native-1', sessionId: identity.sessionId ?? 'native-1', cwd: identity.cwd ?? '/project', settles
  })) {
    const texts: string[] = []
    for (const message of turn.messages) {
      let text = ''
      for await (const chunk of message.text) {
        largest = Math.max(largest, chunk.length)
        text += chunk
      }
      expect(Buffer.byteLength(text, 'utf8')).toBe(message.bytes)
      expect(digest(text)).toBe(message.contentHash)
      texts.push(text)
    }
    turns.push({ ...turn, texts })
  }
  return { turns, largest }
}

describe('native transcript streaming projection', () => {
  it('skips a single tool result larger than 16 MiB and never projects its payload', async () => {
    const payload = `${'tool output '.repeat(1_400_000)}END`.slice(0, 17 * 1024 * 1024)
    // Field order decoy: the huge payload comes before the block `type`, and it contains a
    // nested object whose own keys look exactly like a visible text block.
    const toolResult = `{"type":"user","sessionId":"native-1","message":{"role":"user","content":[{"content":${JSON.stringify(payload)},` +
      `"nested":{"type":"text","text":"decoy body that must never be frozen"},"type":"tool_result","tool_use_id":"tool-1"}]}}\n`
    const path = await transcript([
      claudeUser('measure the archive', 'prompt-1'),
      toolResult,
      claudeAssistant('the archive is 22 MB')
    ])
    const { turns, largest } = await collect(path)
    expect(turns).toHaveLength(1)
    expect(turns[0].texts).toEqual(['measure the archive', 'the archive is 22 MB'])
    expect(turns[0].providerTurnId).toBe('prompt-1')
    expect(turns[0].texts.join('')).not.toContain('decoy body')
    // A projected body never arrives as one big string, whatever the payload size.
    expect(largest).toBeLessThanOrEqual(64 * 1024)
  })

  it('spools a large single visible body and preserves its exact bytes and hash', async () => {
    const body = `${'段落与 emoji 🚀 mixed text\n'.repeat(700_000)}tail`
    const path = await transcript([claudeUser('write it all'), claudeAssistant(body)])
    const { turns, largest } = await collect(path)
    expect(turns[0].texts[1]).toBe(body)
    expect(turns[0].messages[1].bytes).toBe(Buffer.byteLength(body, 'utf8'))
    expect(turns[0].messages[1].contentHash).toBe(digest(body))
    // 17+ MiB can never be one chunk: the spool emits bounded pieces.
    expect(turns[0].messages[1].bytes).toBeGreaterThan(16 * 1024 * 1024)
    expect(largest).toBeLessThanOrEqual(64 * 1024)
  })

  it('freezes the completed prefix and ignores a partial trailing append', async () => {
    const path = await transcript([
      claudeUser('first', 'prompt-1'),
      claudeAssistant('answer one')
    ], '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"half writ')
    const { turns } = await collect(path)
    expect(turns.map(turn => turn.texts)).toEqual([['first', 'answer one']])
  })

  it('keeps the frozen prefix stable when the source is appended to afterwards', async () => {
    const path = await transcript([claudeUser('first', 'prompt-1'), claudeAssistant('answer one')])
    const before = await collect(path)
    await writeFile(path, [
      claudeUser('first', 'prompt-1'),
      claudeAssistant('answer one'),
      claudeUser('second', 'prompt-2'),
      claudeAssistant('answer two')
    ].join(''))
    const after = await collect(path)
    expect(after.turns[0].messages.map(message => message.contentHash))
      .toEqual(before.turns[0].messages.map(message => message.contentHash))
    expect(after.turns[1].texts).toEqual(['second', 'answer two'])
  })

  it('refuses a transcript that names another session or workspace in its own head', async () => {
    const path = await transcript([claudeUser('first', 'prompt-1'), claudeAssistant('answer one')])
    await expect(collect(path, { sessionId: 'other-session' })).rejects.toThrow('属于其他会话')
    await expect(collect(path, { cwd: '/another/project' })).rejects.toThrow('属于其他工作区')
  })

  it('refuses a corrupt record in the middle instead of calling it a truncated tail', async () => {
    const path = await transcript([
      claudeUser('first', 'prompt-1'),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",}]}}\n',
      claudeAssistant('answer one')
    ])
    await expect(collect(path)).rejects.toThrow('原生会话记录')
  })

  it('matches JSON.parse on invalid and duplicate-key records', async () => {
    const cases: Array<{ name: string; record: string }> = [
      { name: 'missing comma', record: '{"type":"user","sessionId":"native-1" "message":{"role":"user","content":"fake"}}' },
      { name: 'missing colon', record: '{"type":"user" "message":{"role":"user","content":"fake"}}' },
      { name: 'trailing comma', record: '{"type":"user","message":{"role":"user","content":"fake"},}' },
      { name: 'invalid number', record: '{"type":"user","isMeta":01,"message":{"role":"user","content":"fake"}}' },
      { name: 'unquoted key', record: '{"type":user,"message":{"role":"user","content":"fake"}}' }
    ]
    for (const sample of cases) {
      // The reader's verdict must be the JSON parser's verdict, never its own opinion.
      const jsonAccepts = ((): boolean => {
        try { JSON.parse(sample.record); return true } catch { return false }
      })()
      expect(jsonAccepts, `${sample.name} must be invalid JSON`).toBe(false)
      const path = await transcript([claudeUser('first', 'prompt-1'), `${sample.record}\n`, claudeAssistant('answer one')])
      await expect(collect(path), sample.name).rejects.toThrow('原生会话记录语法无效')
    }
    // JSON keeps the last duplicate key, and so does this projection: the record is read,
    // not rejected, and the later value decides.
    const duplicate = '{"type":"system","sessionId":"native-1","type":"user","message":{"role":"user","content":[{"type":"text","text":"duplicate wins"}]}}'
    expect((JSON.parse(duplicate) as { type: string }).type).toBe('user')
    const path = await transcript([`${duplicate}\n`, claudeAssistant('answer one')])
    expect((await collect(path)).turns[0].texts).toEqual(['duplicate wins', 'answer one'])
  })

  it('refuses a transcript replaced or truncated while it was read', async () => {
    const path = await transcript([claudeUser('first', 'prompt-1'), claudeAssistant('answer one')])
    const handle = await open(path, 'r+')
    const iterator = streamNativeTranscriptTurns({ path, runId: 'native-1', sessionId: 'native-1', settles })
    try {
      const first = await iterator.next()
      expect(first.done).toBe(false)
      await truncate(path, 0)
      expect(handle).toBeDefined()
      await expect(iterator.next()).rejects.toThrow('在读取期间被替换或截断')
    } finally {
      await handle.close()
      await iterator.return?.(undefined as never)
    }
  })

  it('drops an unfinished turn but refuses an unsettled turn before a settled one', async () => {
    const tailOnly = await transcript([claudeUser('first', 'prompt-1'), claudeAssistant('still running', 'tool_use')])
    expect((await collect(tailOnly)).turns).toEqual([])
    const interior = await transcript([
      claudeUser('first', 'prompt-1'),
      claudeAssistant('unsettled', 'tool_use'),
      claudeUser('second', 'prompt-2'),
      claudeAssistant('answer two')
    ])
    await expect(collect(interior)).rejects.toThrow('没有终止证据的轮次')
  })
})
