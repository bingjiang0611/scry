import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { spanRowsFromItems } from './span-ledger'
import { ProviderRegistry } from './providers/registry'
import type { ProviderAdapter } from './providers/types'
import { readTraceArchive, upsertTraceArchiveTurn } from './transcript-archive'

const event = (
  runId: string,
  id: string,
  fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>
): TraceEvent => ({ id, runId, ts: new Date().toISOString(), ...fields })

describe('fake Provider end-to-end contract', () => {
  it('flows session, tool and result evidence through registry, archive and SQLite row projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-fake-provider-'))
    const userDataDir = join(root, 'user-data')
    const cwd = join(root, 'workspace')
    const runId = 'run-fake-integration'
    const sessionId = 'session-fake-integration'
    const items: TraceEvent[] = []
    const adapter: ProviderAdapter = {
      id: 'claude',
      runtimeProvider: 'claude_sdk',
      describe: async () => ({
        id: 'claude',
        label: 'Fake Claude',
        runtimeProvider: 'claude_sdk',
        transport: 'fake',
        available: true,
        capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
        health: { state: 'ready', transport: 'fake' }
      }),
      run: (request) => {
        request.onExternalSessionId?.(sessionId)
        request.emit(event(runId, `${runId}:tool`, {
          kind: 'tool',
          stage: 'tool_use',
          tool: 'Read',
          toolUseId: 'tool-1',
          input: { file_path: '/repo/package.json' },
          fileOp: 'read',
          filePath: '/repo/package.json'
        }))
        request.emit(event(runId, `${runId}:tool-result`, {
          kind: 'tool',
          stage: 'tool_result',
          tool: 'Read',
          toolUseId: 'tool-1',
          text: '{"name":"scry"}'
        }))
        request.emit(event(runId, `${runId}:result`, {
          kind: 'harness',
          stage: 'result',
          tokensIn: 10,
          tokensOut: 4,
          durationMs: 25
        }))
        return {
          promise: Promise.resolve({ externalSessionId: sessionId, status: 'completed' }),
          interrupt: () => undefined,
          forceKill: () => undefined,
          forceKillScope: 'run_scoped' as const,
          getExternalSessionId: () => sessionId
        }
      }
    }

    try {
      const registry = new ProviderRegistry([adapter])
      const handle = registry.run('claude', {
        runId,
        prompt: 'read package metadata',
        cwd,
        attachments: [],
        emit: (value) => items.push(value),
        onExternalSessionId: (value) => expect(value).toBe(sessionId)
      })
      await expect(handle.promise).resolves.toMatchObject({ externalSessionId: sessionId, status: 'completed' })
      expect(items).toHaveLength(3)
      expect(items.every((value) => value.providerId === 'claude' && value.runtimeProvider === 'claude_sdk')).toBe(true)

      const archived = upsertTraceArchiveTurn({
        cwd,
        sessionId,
        providerId: 'claude',
        runtimeProvider: 'claude_sdk',
        userDataDir,
        turn: {
          runId,
          userText: 'read package metadata',
          items,
          done: true,
          ts: Date.now()
        }
      })
      expect(archived).toBe(true)
      expect(readTraceArchive({ cwd, sessionId, providerId: 'claude', userDataDir })?.turns[0]).toMatchObject({
        runId,
        done: true,
        items: expect.arrayContaining([expect.objectContaining({ stage: 'result', tokensIn: 10 })])
      })

      const rows = spanRowsFromItems({ runId, sessionId, cwd, items, nowMs: Date.now() })
      expect(rows.spans).toHaveLength(2)
      expect(rows.fileOps).toHaveLength(1)
      expect(rows.spans.some((row) => row[12] === 'harness' && row[13] === 'result')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
