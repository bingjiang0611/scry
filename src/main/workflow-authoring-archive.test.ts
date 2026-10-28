import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TRACE_TOOL_CONTENT_POLICY } from './trace-tool-content'
import { persistTraceTurnProgress, recoverTraceTurnProgress } from './trace-turn-progress'
import { readTraceArchive, upsertTraceArchiveTurn } from './transcript-archive'

const roots: string[] = []
const temporaryDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), 'scry-authoring-archive-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('pins the existing App capture budget through terminal recovery without weakening ordinary workspace validation', async () => {
  const cwd = temporaryDirectory()
  const userDataDir = temporaryDirectory()
  writeFileSync(join(cwd, 'scry.config.json'), 'null')
  const context = { cwd, userDataDir, providerId: 'claude' as const,
    runtimeProvider: 'claude_sdk' as const, sessionId: 'authoring-session' }
  const turn = { runId: 'authoring-run', userText: 'produce a candidate', done: true,
    status: 'completed' as const, ts: 1, items: [{ id: 'tool-result', runId: 'authoring-run',
      kind: 'tool' as const, stage: 'tool_result', ts: '2026-10-26T00:00:00Z',
      name: 'StructuredOutput', output: 'x'.repeat(9 * 1024) }] }

  await expect(persistTraceTurnProgress({ ...context, turn })).rejects.toThrow('schemaVersion')
  expect(upsertTraceArchiveTurn({ ...context, turn })).toBe(false)
  expect(readTraceArchive(context)).toBeNull()

  await persistTraceTurnProgress({ ...context,
    turn: { ...turn, toolContentPolicy: TRACE_TOOL_CONTENT_POLICY } })
  await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
  const saved = readTraceArchive(context)!.turns[0]
  expect(saved.toolContentPolicy).toEqual(TRACE_TOOL_CONTENT_POLICY)
  expect(saved.items[0].outputContent).toMatchObject({
    savedBytes: TRACE_TOOL_CONTENT_POLICY.toolContentFieldBytes, storage: 'truncated'
  })
  expect(Buffer.byteLength(saved.items[0].output!)).toBe(TRACE_TOOL_CONTENT_POLICY.toolContentFieldBytes)
  expect(existsSync(join(cwd, '.scry'))).toBe(false)
  await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })

  // A separate ordinary run still consults—and rejects—the malformed workspace policy.
  expect(upsertTraceArchiveTurn({ ...context, turn: { ...turn, runId: 'ordinary-run' } })).toBe(false)
})
