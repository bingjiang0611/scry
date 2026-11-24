import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { recordSessionLineage } from './orchestration-lineage'

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
