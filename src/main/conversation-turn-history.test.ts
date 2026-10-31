import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import type { Conversation } from '../shared/conversation'
import { createConversationTurnLoader } from './conversation-turn-history'
import {
  readTraceArchiveTurnsAsync, traceArchivePath, upsertTraceArchiveTurn, type TraceArchiveTurn
} from './transcript-archive'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-turn-loader-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const cwd = '/repo/turn-loader'

function conversationOf(runIds: readonly string[], sessionId = 'session-1'): Conversation {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    cwd,
    title: 'parent',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    bindings: [{ id: 'binding-1', providerId: 'pi', agentProfileId: 'pi:0123456789abcdef',
      continuationKey: 'key', nativeSessionId: sessionId, createdAt: 1 }],
    turns: runIds.map((runId, index) => ({
      ordinal: index + 1, runId, bindingId: 'binding-1', origin: 'dispatch',
      commandId: `command-${index}`, delivery: { status: 'accepted', nativeSessionId: sessionId,
        outcome: 'completed', nativeItems: [] }, items: [],
      archive: { sessionId }
    }))
  } as unknown as Conversation
}

describe('batched archived turn projection', () => {
  it('reads one session once for every selected turn and never projects unrequested turns', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    const args = { cwd, sessionId: 'session-1', userDataDir, providerId: 'pi' as const }
    // Four unrelated turns already live in the session archive; a page asks for two.
    for (const [runId, ts] of [['unrelated-a', 1], ['wanted-a', 2], ['unrelated-b', 3], ['wanted-b', 4]] as const) {
      expect(upsertTraceArchiveTurn({ ...args, turn: { runId, userText: runId, items: [], done: true, ts } })).toBe(true)
    }
    const calls: string[][] = []
    const load = createConversationTurnLoader({
      userDataDir,
      readTurns: (readArgs, runIds) => {
        calls.push([...runIds])
        return readTraceArchiveTurnsAsync(readArgs as Parameters<typeof readTraceArchiveTurnsAsync>[0], runIds)
      }
    })
    const conversation = conversationOf(['unrelated-a', 'wanted-a', 'unrelated-b', 'wanted-b'])
    const loaded = await load(conversation, [conversation.turns[1], conversation.turns[3]])
    expect(calls).toEqual([['wanted-a', 'wanted-b']])
    expect([...loaded.keys()].sort()).toEqual(['wanted-a', 'wanted-b'])
    expect(loaded.get('wanted-a')?.userText).toBe('wanted-a')
  })

  it('groups turns of different bindings separately instead of merging two archives', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    for (const sessionId of ['session-1', 'session-2']) {
      expect(upsertTraceArchiveTurn({ cwd, sessionId, userDataDir, providerId: 'pi',
        turn: { runId: `${sessionId}-run`, userText: sessionId, items: [], done: true, ts: 1 } })).toBe(true)
    }
    const seen: string[] = []
    const load = createConversationTurnLoader({
      userDataDir,
      readTurns: async (readArgs, runIds) => {
        seen.push(`${readArgs.sessionId}:${runIds.join(',')}`)
        return readTraceArchiveTurnsAsync(readArgs as Parameters<typeof readTraceArchiveTurnsAsync>[0], runIds)
      }
    })
    const conversation = conversationOf(['session-1-run', 'session-2-run'])
    conversation.turns[1] = { ...conversation.turns[1], archive: { sessionId: 'session-2' } }
    const loaded = await load(conversation, conversation.turns)
    expect(seen.sort()).toEqual(['session-1:session-1-run', 'session-2:session-2-run'])
    expect([...loaded.keys()].sort()).toEqual(['session-1-run', 'session-2-run'])
  })

  it('reports missing archive history as unprojected instead of an empty turn', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    mkdirSync(userDataDir, { recursive: true })
    const load = createConversationTurnLoader({ userDataDir })
    const conversation = conversationOf(['never-archived'])
    await expect(load(conversation, conversation.turns)).resolves.toEqual(new Map<string, TraceArchiveTurn>())
  })

  it('does not let one unreadable archive hide the turns of another binding', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    expect(upsertTraceArchiveTurn({ cwd, sessionId: 'session-1', userDataDir, providerId: 'pi',
      turn: { runId: 'good', userText: 'good', items: [], done: true, ts: 1 } })).toBe(true)
    const load = createConversationTurnLoader({
      userDataDir,
      readTurns: async (readArgs, runIds) => {
        if (readArgs.sessionId === 'broken') throw new Error('archive unreadable')
        return readTraceArchiveTurnsAsync(readArgs as Parameters<typeof readTraceArchiveTurnsAsync>[0], runIds)
      }
    })
    const conversation = conversationOf(['good', 'lost'])
    conversation.turns[1] = { ...conversation.turns[1], archive: { sessionId: 'broken' } }
    const loaded = await load(conversation, conversation.turns)
    expect([...loaded.keys()]).toEqual(['good'])
  })

  it('projects the legacy whole-session archive for the requested turns only', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    // An archive written before per-turn segments: one file for the whole session. The
    // indexed reader must fall back to it instead of reporting an empty history.
    const legacy = traceArchivePath(userDataDir, cwd, 'session-1', 'pi')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      version: 3, cwd, sessionId: 'session-1', providerId: 'pi',
      turns: [
        { runId: 'legacy-a', userText: 'old question a', done: true, ts: 1, items: [
          { id: 'e1', runId: 'legacy-a', ts: 1, kind: 'model', stage: 'text', providerId: 'pi', text: 'old answer a' }
        ] },
        { runId: 'legacy-b', userText: 'old question b', done: true, ts: 2, items: [] }
      ]
    }))
    const load = createConversationTurnLoader({ userDataDir })
    const conversation = conversationOf(['legacy-a', 'legacy-b'])
    const loaded = await load(conversation, [conversation.turns[0]])
    expect([...loaded.keys()]).toEqual(['legacy-a'])
    expect(loaded.get('legacy-a')?.userText).toBe('old question a')
    expect(JSON.stringify(loaded.get('legacy-a'))).toContain('old answer a')
  })

  it('reads provider-turn-keyed segments without touching the unrelated one', async () => {
    const userDataDir = join(tempRoot(), 'userData')
    // Claude/Qoder segments are keyed by the provider's own turn id, not by the run id.
    for (const [runId, providerTurnId] of [
      ['run-a', 'pt-a'], ['run-b', 'pt-b'], ['run-c', 'pt-c']
    ] as const) {
      expect(upsertTraceArchiveTurn({ cwd, sessionId: 'session-1', userDataDir, providerId: 'pi',
        turn: { runId, providerTurnId, userText: `question ${runId}`, done: true, ts: 1, items: [] } })).toBe(true)
    }
    const calls: string[][] = []
    const load = createConversationTurnLoader({
      userDataDir,
      readTurns: (readArgs, runIds) => {
        calls.push([...runIds])
        return readTraceArchiveTurnsAsync(readArgs as Parameters<typeof readTraceArchiveTurnsAsync>[0], runIds)
      }
    })
    const conversation = conversationOf(['run-a', 'run-b', 'run-c'])
    const loaded = await load(conversation, [conversation.turns[0], conversation.turns[2]])
    expect(calls).toEqual([['run-a', 'run-c']])
    expect([...loaded.keys()].sort()).toEqual(['run-a', 'run-c'])
    expect(loaded.get('run-c')?.userText).toBe('question run-c')
    expect(JSON.stringify(loaded)).not.toContain('question run-b')
  })

  it('reads nothing when the page has no archived turn', async () => {
    const readTurns = vi.fn()
    const load = createConversationTurnLoader({ userDataDir: '/unused', readTurns })
    const conversation = conversationOf(['imported'])
    delete (conversation.turns[0] as { archive?: unknown }).archive
    await expect(load(conversation, conversation.turns)).resolves.toEqual(new Map())
    expect(readTurns).not.toHaveBeenCalled()
  })
})
