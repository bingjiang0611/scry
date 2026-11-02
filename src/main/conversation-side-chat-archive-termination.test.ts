import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSession } from './app-store'
import { conversationHistoryRoot } from './conversation-history-content'
import { readSideChatManifestItems } from './conversation-side-chat-manifest'
import { catalogService, hash, modelEvent, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { upsertTraceArchiveTurn, type TraceArchiveTurn } from './transcript-archive'
import type { ConversationSideChatRequest } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

// The same shape as a real named Agent Profile; the values are generic.
const PROFILE = 'pi:rotom'
const SESSION = 'pi-rotom-termination-session'
const NO_TERMINAL = '原生会话前缀包含没有终止证据的轮次，不能创建侧聊'
const NOT_COMPLETED = '侧聊边界不是已完成的轮次，请重新预览；本次未创建侧聊'

interface RecordedTurn {
  runId: string
  prompt: string
  answer: string
  done: boolean
  /** The recorder's own status; absent while a run has not been recorded as ended. */
  status?: NonNullable<TraceArchiveTurn['status']>
}

/**
 * Real archives written by the production recorder writer, read through the production
 * native-source seam over a fake catalog. Only the catalog is fake.
 */
async function archiveFixture(): Promise<{
  current: SideChatFixture
  source: ConversationSideChatRequest['source']
  record: (turn: RecordedTurn) => void
}> {
  const current = await sideChatFixture({ providerId: 'pi' })
  fixtures.push(current)
  let ts = 1_800_000_000_000
  const record = (turn: RecordedTurn): void => {
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId: SESSION, providerId: 'pi',
      turn: { runId: turn.runId, userText: turn.prompt, items: [modelEvent(turn.runId, turn.answer)],
        done: turn.done, status: turn.status, ts: ts++, agentProfileId: PROFILE } })
  }
  const catalog: AppSession[] = [{ sessionId: SESSION, externalSessionId: SESSION, providerId: 'pi', cwd: current.cwd,
    preview: '', ts: Date.now(), agentProfileId: PROFILE }]
  current.service = catalogService(current, catalog)
  return { current,
    source: { kind: 'native-session', providerId: 'pi', agentProfileId: PROFILE, cwd: current.cwd, nativeSessionId: SESSION },
    record }
}

/** Sealed snapshot facts: per-message status plus the exact text the child serves. */
async function sealedFacts(current: SideChatFixture, id: string): Promise<{
  throughOrdinal: number
  title: string
  bodyBytes: number
  statuses: string[]
  ordinals: number[]
  texts: string[]
}> {
  const stored = (await current.store.read(id))!
  const snapshot = stored.sideChat!.snapshot
  if (snapshot.format !== 4) throw new Error('the regression expects a format 4 snapshot')
  const items = await readSideChatManifestItems(conversationHistoryRoot(current.userData, stored), snapshot, 0, snapshot.messageCount)
  const refs = await sideChatSnapshotRefs(current.userData, stored)
  return {
    throughOrdinal: snapshot.throughOrdinal,
    title: stored.sideChat!.parentTitleAtCapture,
    bodyBytes: snapshot.bodyBytes,
    statuses: items.map(item => item.status),
    ordinals: items.map(item => item.sourceOrdinal),
    texts: await Promise.all(refs.map(ref => current.service.readItem(id, ref)))
  }
}

const createRequest = (
  source: ConversationSideChatRequest['source'],
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId: string
): ConversationSideChatRequest => ({
  source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
  expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId
})

async function childIds(current: SideChatFixture): Promise<string[]> {
  return (await current.store.list(current.cwd)).filter(conversation => conversation.sideChat).map(conversation => conversation.id)
}

describe('native side-chat archive termination evidence', () => {
  it('captures an interrupted turn before a later completed one and freezes through that completed turn', async () => {
    const { current, source, record } = await archiveFixture()
    record({ runId: 'run-a', prompt: 'question a', answer: 'answer a', done: true, status: 'completed' })
    // A real interruption: the recorder wrote its terminal, the run did not complete.
    record({ runId: 'run-b', prompt: 'question b', answer: 'partial b', done: true, status: 'interrupted' })
    record({ runId: 'run-c', prompt: 'question c', answer: 'answer c', done: true, status: 'completed' })
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(3)
    expect(preview.throughRunId).toBe('run-c')
    expect(preview.messageCount).toBe(6)
    const child = await current.service.createSideChat(createRequest(source, preview, 'termination-interrupted'))
    const sealed = await sealedFacts(current, child.id)
    expect(sealed.throughOrdinal).toBe(3)
    expect(sealed.texts).toEqual(['question a', 'answer a', 'question b', 'partial b', 'question c', 'answer c'])
    // The interrupted turn keeps its captured status; it is never reported as completed.
    expect(sealed.statuses).toEqual(['completed', 'completed', 'interrupted', 'interrupted', 'completed', 'completed'])
    expect(sealed.ordinals).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('ends the default prefix at the last completed turn and leaves out a trailing interrupted turn', async () => {
    const { current, source, record } = await archiveFixture()
    record({ runId: 'run-a', prompt: 'question a', answer: 'answer a', done: true, status: 'completed' })
    record({ runId: 'run-b', prompt: 'trailing b', answer: 'trailing answer b', done: true, status: 'interrupted' })
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(1)
    expect(preview.throughRunId).toBe('run-a')
    expect(preview.messageCount).toBe(2)
    const child = await current.service.createSideChat(createRequest(source, preview, 'termination-trailing'))
    const sealed = await sealedFacts(current, child.id)
    expect(sealed.throughOrdinal).toBe(1)
    expect(sealed.texts).toEqual(['question a', 'answer a'])
    expect(sealed.ordinals).toEqual([1, 1])
    expect(sealed.texts).not.toContain('trailing b')
    // Title and body bytes describe the frozen prefix only, never the turn that ended it.
    expect(sealed.title).toBe('question a')
    expect(sealed.bodyBytes).toBe(Buffer.byteLength('question a') + Buffer.byteLength('answer a'))
    // Creation re-derives both fingerprints from the captured items, so a preview
    // fingerprint that leaked the trailing turn could not have sealed this child.
    expect(sealed.throughOrdinal).toBe(preview.throughOrdinal)
  })

  it('still refuses an interior turn with no recorder terminal', async () => {
    const { current, source, record } = await archiveFixture()
    record({ runId: 'run-a', prompt: 'question a', answer: 'answer a', done: true, status: 'completed' })
    // No terminal at all, although its status already says interrupted: only the
    // recorder terminal is termination evidence, so this turn cannot be captured.
    record({ runId: 'run-b', prompt: 'question b', answer: 'partial b', done: false, status: 'interrupted' })
    record({ runId: 'run-c', prompt: 'question c', answer: 'answer c', done: true, status: 'completed' })
    await expect(current.service.previewSideChat(source)).rejects.toThrow(NO_TERMINAL)
    const historyRoot = join(current.userData, 'conversation-history-v1')
    const before = await readdir(historyRoot).catch(() => [] as string[])
    // The preview cannot offer this prefix, so only a forged request can reach creation.
    // It must still refuse inside the capture, before any fingerprint comparison: the
    // fingerprints below are not a preview's, and nothing may be published or sealed.
    await expect(current.service.createSideChat({ source, expectedThroughOrdinal: 3, expectedThroughRunId: 'run-c',
      expectedPrefixFingerprint: hash('unterminated prefix'), expectedManifestFingerprint: hash('unterminated manifest'),
      commandId: 'termination-unterminated' })).rejects.toThrow(NO_TERMINAL)
    expect(await childIds(current)).toEqual([])
    expect(await readdir(historyRoot).catch(() => [] as string[])).toEqual(before)
  })

  it('reports an interrupted-only archive as having no completed turn', async () => {
    const { current, source, record } = await archiveFixture()
    record({ runId: 'run-a', prompt: 'question a', answer: 'partial a', done: true, status: 'interrupted' })
    // The turn did end, so this is not "no termination evidence": the prefix simply has
    // no completed turn to freeze, and creation stays local.
    await expect(current.service.previewSideChat(source)).rejects.toThrow('该原生会话没有已完成轮次；不会创建空快照')
    expect(await childIds(current)).toEqual([])
  })

  it('refuses an explicitly requested boundary that points at an interrupted turn', async () => {
    const { current, source, record } = await archiveFixture()
    record({ runId: 'run-a', prompt: 'question a', answer: 'answer a', done: true, status: 'completed' })
    record({ runId: 'run-b', prompt: 'question b', answer: 'partial b', done: true, status: 'interrupted' })
    record({ runId: 'run-c', prompt: 'question c', answer: 'answer c', done: true, status: 'completed' })
    await expect(current.service.previewSideChat(source, { completedThroughOrdinal: 2 })).rejects.toThrow(NOT_COMPLETED)
    await expect(current.service.createSideChat({ source, expectedThroughOrdinal: 2, expectedThroughRunId: 'run-b',
      expectedPrefixFingerprint: hash('interrupted boundary'), expectedManifestFingerprint: hash('interrupted manifest'),
      commandId: 'termination-interrupted-boundary' })).rejects.toThrow(NOT_COMPLETED)
    expect(await childIds(current)).toEqual([])
    // Positive control: the completed turn before it is still a usable requested boundary.
    const narrowed = await current.service.previewSideChat(source, { completedThroughOrdinal: 1 })
    expect(narrowed.throughOrdinal).toBe(1)
    expect(narrowed.messageCount).toBe(2)
  })
})
