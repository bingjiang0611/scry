import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamPiNativeTurns } from './pi-native-stream'
import { parsePiNativeHistory } from './pi-native-parse'
import type { StreamedTurn } from './conversation-side-chat-stream'

/**
 * Read positions and a pass hook, so the two-pass contract can be observed exactly.
 *
 * `furthest` resets when a read starts at offset 0: that is how a reader begins a pass, so
 * the value always describes the pass in progress. The hook lets a test change the file at
 * the boundary between the structural pass and the body pass, which is the only window in
 * which a same-size rewrite can mix the first pass's branch with the second pass's bodies.
 */
const probe = vi.hoisted(() => ({
  furthest: new Map<string, number>(),
  passes: 0,
  beforeBodyPass: null as null | (() => Promise<void>)
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      return new Proxy(handle, { get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property !== 'read') return typeof value === 'function' ? value.bind(target) : value
        return async (...read: [unknown, unknown, unknown, unknown]) => {
          const result = await (value as (...inner: unknown[]) => Promise<{ bytesRead: number }>).apply(target, read)
          const position = typeof read[3] === 'number' ? read[3] as number : 0
          const reached = position + result.bytesRead
          probe.furthest.set(path, position === 0 ? reached : Math.max(probe.furthest.get(path) ?? 0, reached))
          return result
        }
      } })
    } }
})
vi.mock('./pi-jsonl-projector', async importOriginal => {
  const actual = await importOriginal<typeof import('./pi-jsonl-projector')>()
  return { ...actual, projectPiRecords: async function* (...args: Parameters<typeof actual.projectPiRecords>) {
    probe.passes += 1
    if (probe.passes === 2 && probe.beforeBodyPass) await probe.beforeBodyPass()
    yield* actual.projectPiRecords(...args)
  } }
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  probe.furthest.clear()
  probe.passes = 0
  probe.beforeBodyPass = null
})

const sessionId = '01a1338c-3d8b-775b-8645-fd964faa29a3'
const cwd = '/repo'
const time = '2026-10-13T04:36:31Z'
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** Pi settles a turn only with its own terminal marker. */
const settles = (stopReason: string | undefined): boolean => stopReason === 'stop'

const header = { type: 'session', version: 3, id: sessionId, cwd }
const user = (id: string, parentId: string | null, text: string) => ({
  type: 'message', id, parentId, timestamp: time, message: { role: 'user', content: [{ type: 'text', text }] }
})
const assistant = (id: string, parentId: string, text: string, stopReason = 'stop') => ({
  type: 'message', id, parentId, timestamp: time,
  message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] }
})
const toolResult = (id: string, parentId: string, text: string, toolCallId = 'call1') => ({
  type: 'message', id, parentId, timestamp: time,
  message: { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text }] }
})

async function sessionFile(entries: readonly unknown[], trailing = ''): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scry-pi-stream-'))
  directories.push(directory)
  const path = join(directory, `session_${sessionId}.jsonl`)
  await writeFile(path, entries.map(entry => `${JSON.stringify(entry)}\n`).join('') + trailing)
  return path
}

async function collect(path: string, identity: { sessionId?: string; cwd?: string } = {}):
Promise<Array<StreamedTurn & { texts: string[]; largest: number }>> {
  const turns: Array<StreamedTurn & { texts: string[]; largest: number }> = []
  for await (const turn of streamPiNativeTurns({
    path, sessionId: identity.sessionId ?? sessionId, cwd: identity.cwd ?? cwd, settles
  })) {
    const texts: string[] = []
    let largest = 0
    for (const message of turn.messages) {
      let text = ''
      for await (const chunk of message.text) {
        largest = Math.max(largest, chunk.length)
        text += chunk
      }
      // The declared byte size and digest are the stored contract, not a second opinion.
      expect(Buffer.byteLength(text, 'utf8')).toBe(message.bytes)
      expect(digest(text)).toBe(message.contentHash)
      texts.push(text)
    }
    turns.push({ ...turn, texts, largest })
  }
  return turns
}

describe('Pi native session streaming', () => {
  it('matches the whole-file reader on the active branch and skips an abandoned one', async () => {
    const entries = [
      header,
      user('u1', null, 'pi question'),
      assistant('a1', 'u1', 'pi answer'),
      // An abandoned attempt: the user rewound and asked something else.
      user('u2', 'a1', 'abandoned question'),
      assistant('a2', 'u2', 'abandoned answer'),
      user('u3', 'a1', 'second question'),
      assistant('a3', 'u3', 'second answer')
    ]
    const path = await sessionFile(entries)

    const streamed = await collect(path)
    expect(streamed.map(turn => turn.texts)).toEqual([
      ['pi question', 'pi answer'],
      ['second question', 'second answer']
    ])
    expect(streamed.map(turn => turn.runId)).toEqual(['pi-native-u1', 'pi-native-u3'])

    // The shipped reader walks the same ancestry; the streamed bodies must agree with it.
    const whole = parsePiNativeHistory(entries.map(entry => JSON.stringify(entry)).join('\n'), { sessionId, cwd })
    expect(whole.map(turn => turn.runId)).toEqual(['pi-native-u1', 'pi-native-u3'])
    expect(whole.map(turn => turn.userText)).toEqual(['pi question', 'second question'])
    for (const [index, turn] of whole.entries()) {
      const answer = turn.items.filter(event => event.stage === 'text').map(event => event.text).join('\n')
      expect(streamed[index].texts[1]).toBe(answer)
    }
  })

  it('skips a single tool result larger than 20 MiB without projecting its payload', async () => {
    const payload = 'x'.repeat(21 * 1024 * 1024)
    const entries = [
      header,
      user('u1', null, 'run it'),
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: time,
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'cat big' } }] } },
      toolResult('t1', 'a1', payload),
      assistant('a2', 't1', 'done')
    ]
    const path = await sessionFile(entries)
    const started = Date.now()
    const turns = await collect(path)
    const elapsed = Date.now() - started
    expect(turns.map(turn => turn.texts)).toEqual([['run it', 'done']])
    // Two passes over 21 MiB stay far below holding the payload in a string.
    expect(turns[0].largest).toBeLessThan(1024)
    expect(elapsed).toBeLessThan(20_000)
    expect((await stat(path)).size).toBeGreaterThan(21 * 1024 * 1024)
  })

  it('spools a large single visible body and keeps its exact bytes', async () => {
    const body = `${'段落与 emoji 🚀 mixed text\n'.repeat(600_000)}tail`
    const path = await sessionFile([header, user('u1', null, 'write it all'), assistant('a1', 'u1', body)])
    const turns = await collect(path)
    expect(turns).toHaveLength(1)
    expect(turns[0].texts[0]).toBe('write it all')
    expect(turns[0].texts[1]).toBe(body)
    // Over the 16 MiB handoff budget even after UTF-8, and still spooled chunk by chunk.
    expect(Buffer.byteLength(turns[0].texts[1], 'utf8')).toBeGreaterThan(16 * 1024 * 1024)
    expect(turns[0].largest).toBeLessThan(2 * 1024 * 1024)
  })

  it('drops an unfinished trailing append and keeps the completed prefix', async () => {
    const path = await sessionFile([header, user('u1', null, 'first'), assistant('a1', 'u1', 'first answer')])
    const before = await collect(path)
    expect(before.map(turn => turn.texts)).toEqual([['first', 'first answer']])

    await appendFile(path, '{"type":"message","id":"a2","parentId":"u1","timestamp":"' + time + '","message":{"role":"assistant"')
    const after = await collect(path)
    expect(after.map(turn => turn.texts)).toEqual([['first', 'first answer']])
    expect(after[0].messages[1].contentHash).toBe(before[0].messages[1].contentHash)
  })

  it('refuses a finished record that is not valid JSON', async () => {
    const path = await sessionFile([header, user('u1', null, 'first')], '{"type":"message","id":"a1",}\n')
    await expect(collect(path)).rejects.toThrow('原生会话记录语法无效')
  })

  it('refuses a session whose header names another session or workspace', async () => {
    const path = await sessionFile([header, user('u1', null, 'first'), assistant('a1', 'u1', 'answer')])
    await expect(collect(path, { sessionId: '01a1338c-3d8b-775b-8645-fd964faa29a4' }))
      .rejects.toThrow('Pi 原生会话身份或格式不匹配')
    await expect(collect(path, { cwd: '/other' })).rejects.toThrow('Pi 原生会话身份或格式不匹配')
  })

  it('refuses a branch that names a missing parent instead of flattening it', async () => {
    const path = await sessionFile([header, user('u1', 'gone', 'orphan'), assistant('a1', 'u1', 'answer')])
    await expect(collect(path)).rejects.toThrow('Pi 原生会话分支不完整')
  })

  it('settles and releases each turn instead of holding every earlier body', async () => {
    // Sixty turns of ~64 KiB visible text: the bodies total nearly twice the allowance, so
    // holding them until EOF would fill it, while one-turn-at-a-time stays far below. The
    // file is also several read chunks long, so the body pass cannot have read it all before
    // the first turn is delivered.
    const body = 'b'.repeat(32 * 1024)
    const entries: unknown[] = [header]
    for (let index = 0; index < 60; index += 1) {
      const userId = `u${index}`
      const answerId = `a${index}`
      entries.push(user(userId, index === 0 ? null : `a${index - 1}`, `question ${index} ${body}`))
      entries.push(assistant(answerId, userId, `answer ${index} ${body}`))
    }
    const path = await sessionFile(entries)
    const size = (await stat(path)).size
    const budget = { available: 2 * 1024 * 1024 }
    let available = budget.available
    let minimum = available
    let furthestAtFirstTurn = 0
    let seen = 0
    for await (const turn of streamPiNativeTurns({
      path, sessionId, cwd, settles
    }, budget)) {
      seen += 1
      // The body pass must not have read the rest of the file to deliver this turn.
      if (seen === 1) furthestAtFirstTurn = probe.furthest.get(path) ?? 0
      for (const message of turn.messages) {
        let text = ''
        for await (const chunk of message.text) text += chunk
        expect(Buffer.byteLength(text, 'utf8')).toBe(message.bytes)
        expect(digest(text)).toBe(message.contentHash)
      }
      available = budget.available
      minimum = Math.min(minimum, available)
    }
    expect(seen).toBe(60)
    // Every body is released, so the allowance is whole again.
    expect(budget.available).toBe(2 * 1024 * 1024)
    // Peak residency: one turn is being consumed and at most one is open, so the whole
    // history never becomes resident. Holding every body instead fills the allowance.
    expect(2 * 1024 * 1024 - minimum).toBeLessThanOrEqual(512 * 1024)
    expect(furthestAtFirstTurn).toBeGreaterThan(0)
    expect(furthestAtFirstTurn).toBeLessThan(size / 2)
  })

  it('refuses a same-size rewrite between the two passes but accepts an append', async () => {
    const entries = [header, user('u1', null, 'pi question'), assistant('a1', 'u1', 'pi answer')]
    const path = await sessionFile(entries)
    // Same byte length, different text: inode, device and size all stay identical.
    const rewritten = entries.map(entry => JSON.stringify(entry).replace('pi answer', 'PI ANSWER')).join('\n') + '\n'
    expect(Buffer.byteLength(rewritten)).toBe((await stat(path)).size)
    probe.beforeBodyPass = async () => { await writeFile(path, rewritten) }
    await expect(collect(path)).rejects.toThrow('Pi 原生会话文件在读取期间被改写')

    // An append after the measured prefix is legal: the frozen prefix did not change.
    const appended = await sessionFile(entries)
    probe.passes = 0
    probe.beforeBodyPass = async () => {
      await appendFile(appended, `${JSON.stringify(user('u2', 'a1', 'later question'))}\n`)
    }
    const turns = await collect(appended)
    expect(turns.map(turn => turn.texts)).toEqual([['pi question', 'pi answer']])
  })

  it('drops a trailing turn with no terminal marker but refuses an interior one', async () => {
    const running = await sessionFile([
      header, user('u1', null, 'first'), assistant('a1', 'u1', 'answer'), user('u2', 'a1', 'still running')
    ])
    expect((await collect(running)).map(turn => turn.texts)).toEqual([['first', 'answer']])

    const interior = await sessionFile([
      header, user('u1', null, 'first'), assistant('a1', 'u1', 'unfinished', 'toolUse'),
      user('u2', 'a1', 'second'), assistant('a2', 'u2', 'answer')
    ])
    await expect(collect(interior)).rejects.toThrow('原生会话前缀包含没有终止证据的轮次')
  })
})
