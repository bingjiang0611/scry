import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePiNativeHistory, readPiNativeHistory, reconcilePiNativeHistory } from './pi-native-history'
import { restoreTraceArchiveTurn, sessionHistoryPage } from './session-history'

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
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })

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
