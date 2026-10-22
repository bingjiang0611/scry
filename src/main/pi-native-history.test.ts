import { appendFileSync } from 'node:fs'
import { mkdtemp, mkdir, open, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePiNativeHistory, readPiNativeHistory, readPiNativeHistorySnapshot, readPiNativeSession, reconcilePiNativeHistory } from './pi-native-history'
import { restoreTraceArchiveTurn, sessionHistoryPage } from './session-history'
import type { TraceEvent } from '../shared/trace'

const identity = { sessionId: '01a1338c-3d8b-775b-8645-fd964faa29a3', cwd: '/repo' }
const header = { type: 'session', version: 3, id: identity.sessionId, cwd: identity.cwd }
const time = '2026-10-13T04:36:31Z'
const user = { type: 'message', id: 'u', parentId: null, timestamp: time, message: { role: 'user', content: [{ type: 'text', text: 'phone message' }] } }
const assistant = { type: 'message', id: 'a', parentId: 'u', timestamp: time,
  message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'pwd' } }] } }
const result = { type: 'message', id: 't', parentId: 'a', timestamp: time,
  message: { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: [{ type: 'text', text: '/repo' }] } }
const encode = (...entries: unknown[]): string => [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')
const roots: string[] = []
const completedResult: TraceEvent = { id: 'done', runId: 'scry-run', ts: time, kind: 'harness',
  stage: 'result', tokensIn: 123, isError: false }
const acceptedSteers: TraceEvent[] = [1, 2].map((index) => ({
  id: `steer-${index}`, runId: 'scry-run', ts: time, kind: 'human', stage: 'steer',
  steer: { messageId: `steer-${index}`, prompt: 'phone message', status: 'accepted', providerTurnId: 'u',
    attachments: index === 1 ? [{ kind: 'image', name: 'steer.png', mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a46kAAAAASUVORK5CYII=' }] : [] }
}))

function nativeHistoryWithSteers() {
  return parsePiNativeHistory(encode(user, assistant, result,
    { ...user, id: 'u2', parentId: 't', message: { role: 'user', content: [
      { type: 'text', text: 'phone message' }, { type: 'image' }
    ] } },
    { ...assistant, id: 'a2', parentId: 'u2', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'call2', name: 'bash', arguments: { command: 'pwd' } }
    ] } },
    { ...result, id: 't2', parentId: 'a2', message: { ...result.message, toolCallId: 'call2' } },
    { ...user, id: 'u3', parentId: 't2' },
    { ...assistant, id: 'a3', parentId: 'u3', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'call3', name: 'bash', arguments: { command: 'pwd' } }
    ] } },
    { ...result, id: 't3', parentId: 'a3', message: { ...result.message, toolCallId: 'call3' } },
    { ...assistant, id: 'final', parentId: 't3', message: { role: 'assistant', content: 'finished' } }
  ), identity)
}
async function nativeFile(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'scry-pi-native-'))
  roots.push(root)
  const sessionRoot = join(root, 'sessions')
  const dir = join(sessionRoot, '--repo--')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `session_${identity.sessionId}.jsonl`)
  await writeFile(path, content)
  return { path, args: { ...identity, sessionRoot } }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

describe('offline Pi native history recovery', () => {
  it('restores phone prompts, real text and matching tool IDs without fabricating billing or a terminal result', () => {
    const turns = parsePiNativeHistory(encode(user, assistant, result), identity)
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe('phone message')
    expect(turns[0].errorHint).toContain('终态、审批、用量与文件变更未核对')
    expect(turns[0].items.map((event) => event.toolUseId)).toEqual([undefined, 'call1', 'call1'])
    expect(turns[0].items[2].output).toBe('/repo')
    expect(turns[0].items.every((event) => event.runtimeMetadata?.source === 'pi_native_transcript')).toBe(true)
    expect(turns[0].items.some((event) => event.stage === 'result' || event.tokensIn !== undefined)).toBe(false)
    expect(turns[0].providerTurnId).toBeUndefined() // no invented fork boundary
  })

  it('keeps a recovered prefix after a continuation gains a canonical archive', () => {
    const nextUser = { ...user, id: 'u2', parentId: 't' }
    const nextReply = { ...assistant, id: 'a2', parentId: 'u2' }
    const native = parsePiNativeHistory(encode(user, assistant, result, nextUser, nextReply), identity)
    const canonical = { runId: 'scry-next', providerTurnId: 'u2', userText: 'phone message', items: [], done: true }
    expect(reconcilePiNativeHistory(native, [canonical])).toEqual([native[0], canonical])
    const unlinked = reconcilePiNativeHistory(native, [{ ...canonical, providerTurnId: undefined }])
    expect(unlinked.map((turn) => turn.runId)).toEqual([...native.map((turn) => turn.runId), 'scry-next'])
    expect(unlinked.at(-1)?.errorHint).toContain('单独保留')
    // An early failed continuation may never create a native user entry. Equal
    // source counts do not mean equal turns: both the prefix and failure survive.
    const failed = { runId: 'failed-before-native', userText: 'failed request', items: [], error: 'offline', done: true }
    const afterFailure = reconcilePiNativeHistory([native[0]], [failed])
    expect(afterFailure.map((turn) => turn.userText)).toEqual(['phone message', 'failed request'])
    expect(afterFailure[1].error).toBe('offline')
  })

  it('keeps an old interrupted attempt before its later linked continuation, not at the end of history', () => {
    const native = parsePiNativeHistory(encode(user, assistant, result,
      { ...user, id: 'u2', parentId: 't' },
      { ...assistant, id: 'a2', parentId: 'u2' }), identity)
    const first = restoreTraceArchiveTurn({ runId: 'first', providerTurnId: 'u', userText: 'phone message', items: [], done: true, ts: 1 })
    const interrupted = restoreTraceArchiveTurn({ runId: 'interrupted', userText: '继续', items: [], done: true, status: 'interrupted', ts: 2 })
    const latest = restoreTraceArchiveTurn({ runId: 'latest', providerTurnId: 'u2', userText: '继续', items: [], done: true, ts: 3 })
    const turns = reconcilePiNativeHistory(native, [first, interrupted, latest])
    expect(turns.map((turn) => turn.runId)).toEqual(['first', 'interrupted', 'latest'])
    expect(turns[1].errorHint).toContain('已中断')
    expect(turns[1].errorHint).toContain('单独保留')
    expect(turns[1].providerTurnId).toBeUndefined()
    expect(sessionHistoryPage(turns, { limit: 1 }).turns).toEqual([latest])
  })

  it('preserves unlinked groups around exact anchors and retains a native-only prefix', () => {
    const native = parsePiNativeHistory(encode(user, assistant, result,
      { ...user, id: 'u2', parentId: 't' }), identity)
    const attempt = (runId: string) => ({ runId, userText: '继续', items: [], done: true })
    const linked = { ...attempt('linked'), providerTurnId: 'u2' }
    const offBranch = { ...attempt('before-2'), providerTurnId: 'abandoned-user' }
    const turns = reconcilePiNativeHistory(native, [attempt('before-1'), offBranch, linked, attempt('after')])
    expect(turns.map((turn) => turn.runId)).toEqual(['pi-native-u', 'before-1', 'before-2', 'linked', 'after'])
    expect(turns[0]).toEqual(native[0])
    expect(turns[2].providerTurnId).toBe('abandoned-user')
    expect(turns[3]).toEqual(linked)
    expect(turns.filter((turn) => turn.errorHint?.includes('单独保留'))).toHaveLength(3)
  })

  it('keeps one canonical run when steers create extra native user boundaries', () => {
    const native = nativeHistoryWithSteers()
    const canonical = restoreTraceArchiveTurn({
      runId: 'scry-run', providerTurnId: 'u', userText: 'phone message',
      items: [...native.flatMap((turn) => turn.items), ...acceptedSteers, completedResult],
      done: true, status: 'completed', ts: 1
    })
    expect(native[1].errorHint).toContain('原始图片未恢复')
    const merged = reconcilePiNativeHistory(native, [canonical])
    expect(merged).toEqual([canonical])
    expect(merged[0]).toBe(canonical)
    expect(merged[0].errorHint).toBeUndefined()
    expect(merged[0].items.filter((event) => event.text === 'finished')).toHaveLength(1)
    expect(merged[0].items.filter((event) => event.stage === 'result')).toHaveLength(1)
    expect(merged[0].items.find((event) => event.stage === 'steer')?.steer?.attachments).toHaveLength(1)
  })

  it('retains an uncovered continuation even when its prompt repeats an archived steer', () => {
    const native = nativeHistoryWithSteers()
    const canonical = { runId: 'scry-run', providerTurnId: 'u', userText: 'phone message',
      items: [...native.slice(0, 2).flatMap((turn) => turn.items), acceptedSteers[0], completedResult], done: true }
    expect(reconcilePiNativeHistory(native, [canonical])).toEqual([canonical, native[2]])
  })

  it('does not hide partial tool evidence, text-only turns, or unanchored archives', () => {
    const native = nativeHistoryWithSteers()
    const canonical = { runId: 'scry-run', providerTurnId: 'u', userText: 'phone message',
      items: [...native.flatMap((turn) => turn.items), ...acceptedSteers, completedResult], done: true }
    const unfinished = { ...canonical, items: canonical.items.filter((event) => event.stage !== 'result') }
    expect(reconcilePiNativeHistory(native, [unfinished])).toEqual([unfinished, ...native.slice(1)])
    const partial = { ...canonical, items: canonical.items.filter((event) =>
      !(event.toolUseId === 'call2' && event.stage === 'tool_result')) }
    expect(reconcilePiNativeHistory(native, [partial])).toEqual([partial, native[1]])
    const textOnly = { ...native[1], items: native[1].items.filter((event) => !event.toolUseId) }
    expect(reconcilePiNativeHistory([native[0], textOnly], [canonical])).toEqual([canonical, textOnly])
    const unanchored = reconcilePiNativeHistory(native, [{ ...canonical, providerTurnId: 'off-branch' }])
    expect(unanchored.slice(0, native.length)).toEqual(native)
    expect(unanchored.at(-1)?.errorHint).toContain('单独保留')
  })

  it('preserves native inputs absent from the archive and counts repeated accepted steers only once per message', () => {
    const native = nativeHistoryWithSteers()
    const canonical = { runId: 'scry-run', providerTurnId: 'u', userText: 'phone message',
      items: [...native.flatMap((turn) => turn.items), completedResult], done: true }
    expect(reconcilePiNativeHistory(native, [canonical])).toEqual([canonical, ...native.slice(1)])
    const oneInput = { ...canonical, items: [...canonical.items, acceptedSteers[0], acceptedSteers[0]] }
    expect(reconcilePiNativeHistory(native, [oneInput])).toEqual([oneInput, native[2]])
    const rejected = { ...canonical, items: [...canonical.items, { ...acceptedSteers[0],
      steer: { ...acceptedSteers[0].steer!, status: 'rejected' as const } }] }
    expect(reconcilePiNativeHistory(native, [rejected])).toEqual([rejected, ...native.slice(1)])
    const otherInput = { ...canonical, items: [...canonical.items, { ...acceptedSteers[0],
      steer: { ...acceptedSteers[0].steer!, prompt: 'different input' } }] }
    expect(reconcilePiNativeHistory(native, [otherInput])).toEqual([otherInput, ...native.slice(1)])
  })

  it('does not use another archive or a later anchor to absorb a native turn', () => {
    const native = nativeHistoryWithSteers()
    const first = { runId: 'first', providerTurnId: 'u', userText: 'phone message', items: native[0].items, done: true }
    const later = { runId: 'later', providerTurnId: 'u3', userText: 'phone message',
      items: native.slice(1).flatMap((turn) => turn.items), done: true }
    expect(reconcilePiNativeHistory(native, [first, later])).toEqual([first, native[1], later])
    const firstWithSteer = { ...first, items: [...native.slice(0, 2).flatMap((turn) => turn.items), acceptedSteers[0], completedResult] }
    expect(reconcilePiNativeHistory(native, [firstWithSteer, later])).toEqual([firstWithSteer, native[1], later])
  })

  it('follows current leaf ancestry instead of showing abandoned branch messages', () => {
    const abandoned = { ...assistant, id: 'old', message: { role: 'assistant', content: 'discarded answer' } }
    const turns = parsePiNativeHistory(encode(user, abandoned, assistant, result), identity)
    expect(JSON.stringify(turns)).not.toContain('discarded answer')
    expect(turns[0].items).toHaveLength(3)
  })

  it('rejects mismatched header identities and incomplete ancestry rather than claiming empty history', () => {
    expect(() => parsePiNativeHistory(encode(user), { ...identity, cwd: '/other' })).toThrow('身份')
    expect(() => parsePiNativeHistory(encode(user), { ...identity, sessionId: 'other' })).toThrow('身份')
    expect(() => parsePiNativeHistory(encode(assistant), identity)).toThrow('分支不完整')
    expect(() => parsePiNativeHistory(encode({ ...user, parentId: 'u' }), identity)).toThrow('循环')
    expect(() => parsePiNativeHistory(encode(user, user), identity)).toThrow('entry id')
  })

  it('streams histories larger than 64 MiB and keeps only the current branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-native-large-'))
    roots.push(root)
    const sessionRoot = join(root, 'sessions')
    const dir = join(sessionRoot, '--repo--')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `large_${identity.sessionId}.jsonl`)
    const file = await open(path, 'w')
    try {
      await file.writeFile(`${encode(user)}\n`)
      const padding = 'x'.repeat(1024 * 1024)
      for (let index = 0; index < 65; index++) {
        await file.writeFile(`${JSON.stringify({ ...assistant, id: `abandoned-${index}`,
          message: { role: 'assistant', content: padding } })}\n`)
      }
      // Include a multi-chunk active record with UTF-8, CRLF and no final newline.
      const reply = { ...assistant, message: { role: 'assistant', content: '你好🙂'.repeat(16000) } }
      await file.writeFile(`${JSON.stringify(reply)}\r\n${JSON.stringify(result)}`)
      expect((await stat(path)).size).toBeGreaterThan(64 * 1024 * 1024)
      const turns = await readPiNativeHistory({ ...identity, sessionRoot })
      expect(turns).toEqual(parsePiNativeHistory(encode(user, reply, result), identity))
      expect(turns?.[0].items[1].output).toBe('/repo')
      await expect(readPiNativeSession({ ...identity, sessionRoot })).rejects.toThrow('aggregate byte budget')
    } finally {
      await file.close()
    }
  })

  it.each([
    ['', '身份'],
    [JSON.stringify({ ...header, cwd: '/other' }), '身份'],
    [encode(user, user), 'entry id'],
    [encode(assistant), '分支不完整'],
    [encode({ ...user, parentId: 'u' }), '循环'],
    [encode(user, { ...assistant, timestamp: 'invalid' }), '时间无效'],
    [`${encode(user)}\n{`, 'JSON']
  ])('rejects invalid streamed history rather than returning partial success (%#)', async (content, error) => {
    const { args } = await nativeFile(content)
    await expect(readPiNativeHistory(args)).rejects.toThrow(error)
  })

  it('selects metadata first, hydrates only requested native turns, and validates append prefixes', async () => {
    const first = encode(user, assistant, result)
    const { args, path } = await nativeFile(first)
    const initial = await readPiNativeHistorySnapshot(args)
    expect(initial?.turns).toHaveLength(1)
    expect(initial?.turns[0].items.map((item) => item.toolUseId)).toEqual(['call1', 'call1'])
    expect(initial?.turns[0].items.every((item) => item.text == null && item.output == null)).toBe(true)
    const hydrated = await initial!.hydrate([initial!.turns[0].runId!])
    expect(hydrated[0].items).toHaveLength(3)

    const secondUser = { ...user, id: 'u2', parentId: 't' }
    await writeFile(path, `${first}\n${JSON.stringify(secondUser)}`)
    const appended = await readPiNativeHistorySnapshot(args)
    expect(appended?.sourceRevision).not.toBe(initial?.sourceRevision)
    expect(appended?.turns.map((turn) => turn.runId)).toEqual(['pi-native-u', 'pi-native-u2'])
    expect(await appended!.hydrate(['pi-native-u'])).toHaveLength(1)
    expect((await appended!.hydrate(['pi-native-u2']))[0].userText).toBe('phone message')

    await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(user)}`)
    const rewritten = await readPiNativeHistorySnapshot(args)
    expect(rewritten?.turns.map((turn) => turn.runId)).toEqual(['pi-native-u'])
  })

  it('rejects equal-length replacement while hydrating an older snapshot and normalizes multiline prompts', async () => {
    const multilineUser = { ...user, message: { role: 'user', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] } }
    const { args, path } = await nativeFile(encode(multilineUser, assistant, result))
    const snapshot = await readPiNativeHistorySnapshot(args)
    expect(snapshot?.turns[0].userText).toBe('line one\nline two')
    const replacement = { ...multilineUser, message: { role: 'user', content: [{ type: 'text', text: 'line aaa' }, { type: 'text', text: 'line bbb' }] } }
    await writeFile(path, encode(replacement, assistant, result))
    await expect(snapshot!.hydrate([snapshot!.turns[0].runId!])).rejects.toThrow('读取期间发生变化')
  })

  it('handles blank lines, header-only histories and forward references like the string parser', async () => {
    for (const content of [JSON.stringify(header), `\n${JSON.stringify(header)}\r\n\n`,
      encode(assistant, user, result)]) {
      const { args } = await nativeFile(content)
      expect(await readPiNativeHistory(args)).toEqual(parsePiNativeHistory(content, identity))
    }
  })

  it('rejects cancellation before and during the scan', async () => {
    const { args } = await nativeFile(encode(user, assistant, result))
    const controller = new AbortController()
    const check = controller.signal.throwIfAborted.bind(controller.signal)
    const abort = vi.spyOn(controller.signal, 'throwIfAborted')
      .mockImplementationOnce(check)
      .mockImplementationOnce(() => { controller.abort(); check() })
    await expect(readPiNativeHistory({ ...args, signal: controller.signal })).rejects.toThrow('aborted')
    expect(abort).toHaveBeenCalledTimes(2)
    await expect(readPiNativeHistory({ ...args, signal: controller.signal })).rejects.toThrow('aborted')
  })

  it('does not present a changed file as a reconciled snapshot', async () => {
    const { args, path } = await nativeFile(encode(user, assistant, result))
    const signal = new AbortController().signal
    vi.spyOn(signal, 'throwIfAborted')
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { appendFileSync(path, '\n') })
    await expect(readPiNativeHistory({ ...args, signal })).rejects.toThrow('读取期间发生变化')
  })

  it('bounds individual records even though the overall file can exceed 64 MiB', async () => {
    const { args, path } = await nativeFile(`${JSON.stringify(header)}\n`)
    const file = await open(path, 'r+')
    try { await file.truncate(65 * 1024 * 1024) } finally { await file.close() }
    await expect(readPiNativeHistory(args)).rejects.toThrow('单条记录超过 64 MiB')
  })

  it('reads only the validated native file and refuses symlink escape and ambiguous copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-native-'))
    roots.push(root)
    const sessionRoot = join(root, 'sessions')
    const dir = join(sessionRoot, '--repo--')
    await mkdir(dir, { recursive: true })
    const args = { ...identity, sessionRoot }
    expect(await readPiNativeHistory(args)).toBeNull()
    const path = join(dir, `2026-10-13_${identity.sessionId}.jsonl`)
    await writeFile(path, encode(user, assistant, result))
    expect((await readPiNativeHistory(args))?.[0].items).toHaveLength(3)
    await expect(readPiNativeHistory({ ...args, maxBytes: 1 })).rejects.toThrow('aggregate byte budget')
    const second = join(dir, `duplicate_${identity.sessionId}.jsonl`)
    await writeFile(second, encode(user))
    await expect(readPiNativeHistory(args)).rejects.toThrow('不唯一')
    await rm(second)
    await rm(path)
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, encode(user))
    await symlink(outside, path)
    await expect(readPiNativeHistory(args)).rejects.toThrow('越界')
  })
})
