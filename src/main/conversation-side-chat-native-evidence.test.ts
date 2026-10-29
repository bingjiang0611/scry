import { mkdir, realpath, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeTranscriptLine,
  nativeSideChatFixture,
  writeClaudeTranscript
} from './conversation-side-chat.fixture'
import { MAX_CONVERSATION_HISTORY_SOURCE_BYTES } from './conversation-history-limits'
import { readPiNativeHistory } from './pi-native-history'
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
    const page = await current.service.read(child.id)
    expect(page.sideChat?.throughOrdinal).toBe(1)
    const texts = await Promise.all(page.sideChat!.items.map(item => current.service.readItem(child.id, item.ref)))
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
    const page = await current.service.read(child.id)
    const texts = await Promise.all(page.sideChat!.items.map(item => current.service.readItem(child.id, item.ref)))
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

  it('refuses a source that exceeds the 16 MiB side-chat read budget before parsing it', async () => {
    const claudeSessionId = '51111111-2222-4333-8444-555555555555'
    const claude = await fixture('claude', claudeSessionId)
    const claudePath = await writeClaudeTranscript(claude.home, claude.current.cwd, claudeSessionId, [
      claudeTranscriptLine(claude.current.cwd, claudeSessionId, 'user', 'claude question'),
      claudeTranscriptLine(claude.current.cwd, claudeSessionId, 'assistant', 'claude answer')
    ])
    await truncate(claudePath, MAX_CONVERSATION_HISTORY_SOURCE_BYTES + 1)
    await expect(claude.current.service.previewSideChat({ kind: 'native-session', providerId: 'claude',
      cwd: claude.current.cwd, nativeSessionId: claudeSessionId })).rejects.toThrow('16 MiB')

    const piSessionId = '61111111-2222-4333-8444-555555555555'
    const pi = await fixture('pi', piSessionId)
    const piPath = await writePiSession(pi.home, pi.current.cwd, piSessionId, [
      piRecord({ id: 'u1', parentId: null, role: 'user', text: 'pi question' })
    ])
    await truncate(piPath, MAX_CONVERSATION_HISTORY_SOURCE_BYTES + 1)
    await expect(pi.current.service.previewSideChat({ kind: 'native-session', providerId: 'pi',
      cwd: pi.current.cwd, nativeSessionId: piSessionId })).rejects.toThrow('byte budget')
  })

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
