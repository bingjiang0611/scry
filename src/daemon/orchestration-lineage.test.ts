import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { recordSessionLineage } from './orchestration-lineage'
import { sideChatLineageInput } from './orchestration-side-chat-lineage'

const PEER = `peer:${'a'.repeat(64)}`
let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sink(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-lineage-'))
  dirs.push(userData)
  return EventSink.open({ userDataDir: userData, authorizedActors: [PEER] })
}

// D3: the columns existed and stayed empty because no production path recorded a fork. The
// lineage has to be an event, so a projection rebuilt from events keeps the same tree.

describe('D3: session lineage is recorded, not inferred', () => {
  it('records a fork with its parent and root', () => {
    const handle = sink()
    try {
      const result = recordSessionLineage(handle, {
        sessionKey: 'native-child',
        parentSessionKey: 'native-parent',
        provider: 'codex',
        cwd: '/tmp/ws',
        lineage: { kind: 'fork', source: { sessionKey: 'native-parent', runId: 'run-parent', throughOrdinal: 3 } }
      }, 1_700_000_000_000)
      expect(result.status).toBe('recorded')
      const session = handle.getSession('native-child')
      expect(session).toMatchObject({
        parentSessionKey: 'native-parent',
        rootSessionKey: 'native-parent',
        lineage: { kind: 'fork', source: { sessionKey: 'native-parent', runId: 'run-parent', throughOrdinal: 3 } },
        createdBy: 'system'
      })
    } finally {
      handle.close()
    }
  })

  it('records a side chat through session.create and is idempotent for the same id', () => {
    const handle = sink()
    try {
      const input = {
        sessionKey: 'native-side',
        parentSessionKey: 'native-parent',
        conversationId: 'conv-side',
        lineage: { kind: 'side_chat' as const, source: { sessionKey: 'native-parent', throughOrdinal: 2 } }
      }
      expect(recordSessionLineage(handle, input, 1_700_000_000_000).status).toBe('recorded')
      expect(recordSessionLineage(handle, input, 1_700_000_000_500).status).toBe('recorded')
      expect(handle.getSession('native-side')).toMatchObject({
        parentSessionKey: 'native-parent',
        lineage: { kind: 'side_chat' }
      })
      const lineageEvents = handle.listEvents().filter((event) => event.type === 'session.created')
      expect(lineageEvents).toHaveLength(1)
    } finally {
      handle.close()
    }
  })
})

// D3: a side chat cannot record lineage at creation (no native session yet). The startup observer
// records it on the first delivered turn, so the tree is complete without a client describing it.
describe('D3: side chat lineage is attached when the session first exists', () => {
  it('writes the child row only once the provider answered', () => {
    const handle = sink()
    try {
      handle.execute({
        type: 'run.submit',
        commandId: 'run-1',
        actor: PEER,
        scope: 'remote',
        at: 5,
        payload: { runId: 'run-1', sessionKey: 'native-parent', provider: 'pi', profile: null, cwd: '/w', promptPreview: 'p' }
      } as never)
      const conversation = {
        id: 'conv-child', cwd: '/w', revision: 2,
        bindings: [{ id: 'b1', providerId: 'pi' as const, continuationKey: 'k', nativeSessionId: 'native-child' }],
        sideChat: {
          source: { kind: 'native-session' as const, providerId: 'pi' as const, cwd: '/w', nativeSessionId: 'native-parent' },
          parentTitleAtCapture: 'p', initialTarget: { providerId: 'pi' as const },
          snapshot: {
            format: 4 as const, id: 's1', prefixFingerprint: 'pf', throughOrdinal: 1, throughRunId: 'run-1',
            capturedAt: 1, messageCount: 0, bodyBytes: 0,
            items: { root: { storage: 'recorder-content-v1' as const, sha256: 'r', bytes: 0, encoding: 'json' as const }, from: 0, count: 0, bytes: 0, fanout: 8 }
          },
          commandId: 'c1', intentHash: 'h1'
        }
      }
      const input = sideChatLineageInput(conversation, 'native-child', {
        parentSessionKeyOf: (id) => handle.getSessionByConversation(id)?.sessionKey
      })
      expect(recordSessionLineage(handle, input!, 10)).toEqual({ status: 'recorded' })
      expect(handle.getSession('native-child')).toMatchObject({
        parentSessionKey: 'native-parent',
        rootSessionKey: 'native-parent',
        lineage: { kind: 'side_chat', source: { sessionKey: 'native-parent' } }
      })
      // Re-recording the same edge is a duplicate, not a second row.
      expect(recordSessionLineage(handle, input!, 11)).toEqual({ status: 'recorded' })
      expect(handle.getSession('native-child')?.lineage).toEqual({ kind: 'side_chat', source: { sessionKey: 'native-parent' } })
    } finally { handle.close() }
  })

  it('finds a parent session by conversation', () => {
    const handle = sink()
    try {
      const payload = { sessionKey: 'native-parent', conversationId: 'conv-parent', provider: 'pi', cwd: '/w' }
      handle.execute({
        type: 'session.create', commandId: 'create-parent', actor: 'system', scope: 'system', at: 1,
        payload, payloadSha256: sha256Hex(canonicalJson(payload))
      } as never)
      expect(handle.getSessionByConversation('conv-parent')?.sessionKey).toBe('native-parent')
      expect(handle.getSessionByConversation('missing')).toBeUndefined()
    } finally { handle.close() }
  })
})
