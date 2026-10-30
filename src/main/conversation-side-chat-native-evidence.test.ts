import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeTranscriptLine,
  nativeSideChatFixture,
  writeClaudeTranscript
} from './conversation-side-chat.fixture'
import { readPiNativeHistory } from './pi-native-history'
import { INLINE_CANDIDATE_ITEMS, sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import type { ConversationSideChatRequest } from '../shared/conversation-api'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function fixture(providerId: 'claude' | 'pi', sessionId: string) {
  const native = await nativeSideChatFixture(providerId, sessionId)
  cleanups.push(native.cleanup)
  return native
}

function piRecord(args: {
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  text: string
  stopReason?: string
}): Record<string, unknown> {
  return { type: 'message', id: args.id, parentId: args.parentId, timestamp: '2026-10-13T04:36:31Z',
    message: { role: args.role, content: [{ type: 'text', text: args.text }],
      ...(args.stopReason ? { stopReason: args.stopReason } : {}) } }
}

async function writePiSession(
  home: string,
  cwd: string,
  sessionId: string,
  records: Array<Record<string, unknown>>
): Promise<string> {
  const directory = join(home, '.pi', 'agent', 'sessions',
    `--${(await realpath(cwd)).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `session_${sessionId}.jsonl`)
  await writeFile(path, [JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }), ...records.map(entry => JSON.stringify(entry))]
    .join('\n'))
  return path
}

function request(
  source: ConversationSideChatRequest['source'],
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId = 'side-chat-evidence'
): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

describe('native side-chat completion evidence', () => {
  it('negative control: visible in-flight assistant text alone is not a completed turn', async () => {
    const sessionId = '33333333-2222-4333-8444-555555555555'
    const { current, home } = await fixture('claude', sessionId)
    const source = { kind: 'native-session' as const, providerId: 'claude' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const path = await writeClaudeTranscript(home, current.cwd, sessionId, [
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question one', { promptId: 'prompt-1' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude answer one'),
      // The running turn has already shown a sentence and is calling a tool.
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question two', { promptId: 'prompt-2' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude in-flight sentence', { stopReason: 'tool_use' })
    ])
    // The replaced rule froze any turn with assistant text; this turn has text but
    // no terminal marker, which is exactly what must not be frozen.
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(1)
    expect(preview.messageCount).toBe(2)
    expect(preview.prefixFingerprint).toBe(
      (await current.service.previewSideChat(source, { completedThroughOrdinal: 1 })).prefixFingerprint)

    // The chosen prefix stays frozen when that in-flight turn finishes.
    await writeFile(path, [
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question one', { promptId: 'prompt-1' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude answer one'),
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question two', { promptId: 'prompt-2' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude in-flight sentence', { stopReason: 'tool_use' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude answer two')
    ].join(''))
    expect((await current.service.previewSideChat(source)).throughOrdinal).toBe(2)
    const child = await current.service.createSideChat(request(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect((await current.store.read(child.id))!.sideChat?.snapshot.throughOrdinal).toBe(1)
    const texts = await Promise.all(refs.map(ref => current.service.readItem(child.id, ref)))
    expect(texts).toEqual(['claude question one', 'claude answer one'])
  })

  it('reads the Pi terminal marker through the metadata and hydration paths', async () => {
    const sessionId = '0211338c-3d8b-775b-8645-fd964faa29a3'
    const { current, home } = await fixture('pi', sessionId)
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    await writePiSession(home, current.cwd, sessionId, [
      piRecord({ id: 'u1', parentId: null, role: 'user', text: 'pi question one' }),
      piRecord({ id: 'a1', parentId: 'u1', role: 'assistant', text: 'pi answer one', stopReason: 'stop' }),
      piRecord({ id: 'u2', parentId: 'a1', role: 'user', text: 'pi question two' }),
      // Streaming: the runtime has not finished this assistant message.
      piRecord({ id: 'a2', parentId: 'u2', role: 'assistant', text: 'pi in-flight', stopReason: 'toolUse' })
    ])
    const hydrated = await readPiNativeHistory({
      sessionRoot: join(home, '.pi', 'agent', 'sessions'), cwd: current.cwd, sessionId
    })
    // Both markers survive hydration, so the source can tell finished from running.
    expect(hydrated?.map(turn => turn.stopReason)).toEqual(['stop', 'toolUse'])
    expect(hydrated?.map(turn => turn.runId)).toEqual(['pi-native-u1', 'pi-native-u2'])

    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(1)
    expect(preview.messageCount).toBe(2)
    const child = await current.service.createSideChat(request(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    const texts = await Promise.all(refs.map(ref => current.service.readItem(child.id, ref)))
    expect(texts).toEqual(['pi question one', 'pi answer one'])
  })

  it('refuses a native source that has visible text but no completion evidence at all', async () => {
    const sessionId = '0411338c-3d8b-775b-8645-fd964faa29a3'
    const { current, home } = await fixture('pi', sessionId)
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    await writePiSession(home, current.cwd, sessionId, [
      piRecord({ id: 'u1', parentId: null, role: 'user', text: 'pi question' }),
      // A missing marker stays unknown; visible text cannot stand in for it.
      piRecord({ id: 'a1', parentId: 'u1', role: 'assistant', text: 'pi partial answer' })
    ])
    await expect(current.service.previewSideChat(source)).rejects.toThrow('没有已完成轮次')
    expect((await current.store.list(current.cwd)).length).toBe(0)
  })

  it('captures a completed prefix from a transcript far beyond the old 16 MiB budget', async () => {
    const claudeSessionId = '51111111-2222-4333-8444-555555555555'
    const claude = await fixture('claude', claudeSessionId)
    // 40 exchanges of 512 KiB each: the frozen prefix is ~20 MiB, so only streaming
    // parsing can reach it. The last record is left half-written on purpose.
    const filler = '字'.repeat(170_000)
    const lines: string[] = []
    for (let index = 0; index < 40; index += 1) {
      lines.push(claudeTranscriptLine(claude.current.cwd, claudeSessionId, 'user', `问题 ${index} ${filler}`, { promptId: `prompt-${index}` }))
      lines.push(claudeTranscriptLine(claude.current.cwd, claudeSessionId, 'assistant', `回答 ${index} ${filler}`))
    }
    await writeClaudeTranscript(claude.home, claude.current.cwd, claudeSessionId, lines)
    const source = { kind: 'native-session' as const, providerId: 'claude' as const,
      cwd: claude.current.cwd, nativeSessionId: claudeSessionId }
    const preview = await claude.current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(40)
    const child = await claude.current.service.createSideChat(request(source, preview))
    const record = (await claude.current.store.read(child.id))!
    expect(record.sideChat?.snapshot.format).toBe(4)
    const refs = await sideChatSnapshotRefs(claude.current.userData, record)
    expect(refs.length).toBeGreaterThan(60)
    // The half-written tail is not evidence, so it never becomes a frozen message.
    expect(await claude.current.service.readItem(child.id, refs.at(-1)!)).toBe(`回答 39 ${filler}`)

    const piSessionId = '61111111-2222-4333-8444-555555555555'
    const pi = await fixture('pi', piSessionId)
    const piFiller = '字'.repeat(170_000)
    const records: Array<Record<string, unknown>> = []
    let parent: string | null = null
    for (let index = 0; index < 40; index += 1) {
      const ask = `pi-question-${index}`
      records.push(piRecord({ id: ask, parentId: parent, role: 'user', text: `问题 ${index} ${piFiller}` }))
      const answer = `pi-answer-${index}`
      records.push(piRecord({ id: answer, parentId: ask, role: 'assistant', text: `回答 ${index} ${piFiller}`, stopReason: 'stop' }))
      parent = answer
    }
    await writePiSession(pi.home, pi.current.cwd, piSessionId, records)
    const piSource = { kind: 'native-session' as const, providerId: 'pi' as const,
      cwd: pi.current.cwd, nativeSessionId: piSessionId }
    const piPreview = await pi.current.service.previewSideChat(piSource)
    expect(piPreview.throughOrdinal).toBe(40)
    const piChild = await pi.current.service.createSideChat(request(piSource, piPreview))
    const piRefs = await sideChatSnapshotRefs(pi.current.userData, (await pi.current.store.read(piChild.id))!)
    expect(piRefs.length).toBeGreaterThan(60)
    expect(await pi.current.service.readItem(piChild.id, piRefs.at(-1)!)).toBe(`回答 39 ${piFiller}`)
  }, 180_000)

  it('freezes more than 2000 turns and 4000 messages without one request per item', async () => {
    const sessionId = '71111111-2222-4333-8444-555555555555'
    const claude = await fixture('claude', sessionId)
    // 2100 exchanges: past the old 2000-turn budget and 4200 frozen messages.
    const lines: string[] = []
    for (let index = 0; index < 2100; index += 1) {
      lines.push(claudeTranscriptLine(claude.current.cwd, sessionId, 'user', `问题 ${index}`, { promptId: `prompt-${index}` }))
      lines.push(claudeTranscriptLine(claude.current.cwd, sessionId, 'assistant', `回答 ${index}`))
    }
    await writeClaudeTranscript(claude.home, claude.current.cwd, sessionId, lines)
    const source = { kind: 'native-session' as const, providerId: 'claude' as const,
      cwd: claude.current.cwd, nativeSessionId: sessionId }
    const preview = await claude.current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(2100)
    expect(preview.messageCount).toBe(4200)
    const child = await claude.current.service.createSideChat(request(source, preview, 'side-chat-4200'))
    const record = (await claude.current.store.read(child.id))!
    const snapshot = record.sideChat?.snapshot
    if (snapshot?.format !== 4) throw new Error('creation must seal a format 4 snapshot')
    expect(snapshot.messageCount).toBe(4200)
    // The durable child record stays a descriptor, not one reference per message.
    expect(JSON.stringify(record).length).toBeLessThan(20_000)
    // The plan carries only the inline window: a 4200-message child must not be
    // enumerated into the preview, the send request or the IPC payload.
    const plan = await claude.current.service.preview(child.id, { providerId: 'claude' })
    if (plan.continuation.kind === 'blocked') throw new Error(plan.continuation.reason)
    expect(plan.continuation.missingItems.length).toBeGreaterThan(0)
    expect(plan.continuation.missingItems.length).toBeLessThanOrEqual(INLINE_CANDIDATE_ITEMS)
    expect(plan.missingItems.length).toBe(plan.continuation.missingItems.length)
    const refs = await sideChatSnapshotRefs(claude.current.userData, record)
    expect(refs.length).toBe(4200)
    for (const [index, expected] of [[0, '问题 0'], [2099, '回答 1049'], [4199, '回答 2099']] as const) {
      expect(await claude.current.service.readItem(child.id, refs[index])).toBe(expected)
    }
  }, 240_000)

  it('refuses creation when the chosen turn content changed after the preview', async () => {
    const sessionId = '71111111-2222-4333-8444-555555555555'
    const { current, home } = await fixture('claude', sessionId)
    const source = { kind: 'native-session' as const, providerId: 'claude' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const path = await writeClaudeTranscript(home, current.cwd, sessionId, [
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question one', { promptId: 'prompt-1' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude answer one')
    ])
    const preview = await current.service.previewSideChat(source)
    await writeFile(path, [
      claudeTranscriptLine(current.cwd, sessionId, 'user', 'claude question one', { promptId: 'prompt-1' }),
      claudeTranscriptLine(current.cwd, sessionId, 'assistant', 'claude rewritten answer')
    ].join(''))
    await expect(current.service.createSideChat(request(source, preview)))
      .rejects.toThrow('来源快照范围已变化')
    expect((await current.store.list(current.cwd)).length).toBe(0)
  })

  it('refuses a catalog session with no proven workspace instead of reading its session id', async () => {
    const sessionId = '81111111-2222-4333-8444-555555555555'
    const { current, home, catalog } = await fixture('pi', sessionId)
    await writePiSession(home, current.cwd, sessionId, [
      piRecord({ id: 'u1', parentId: null, role: 'user', text: 'pi question' }),
      piRecord({ id: 'a1', parentId: 'u1', role: 'assistant', text: 'pi answer', stopReason: 'stop' })
    ])
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    catalog[0] = { ...catalog[0], cwd: '' }
    await expect(current.service.previewSideChat(source)).rejects.toThrow('工作区与已登记会话不一致')
    catalog[0] = { ...catalog[0], cwd: current.cwd }
    await expect(current.service.previewSideChat(source)).resolves.toBeDefined()
  })
})
