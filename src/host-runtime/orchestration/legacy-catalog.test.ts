import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { importCatalogEntries } from './legacy-catalog-and-repair'

function withCatalogTest(run: (sink: EventSink, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-legacy-catalog-test-'))
  const sink = EventSink.open({ userDataDir: dir })
  try {
    run(sink, dir)
  } finally {
    sink.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const entry = {
  sessionId: 'legacy',
  providerId: 'codex',
  agentProfileId: 'default',
  cwd: '/tmp/工作区',
  title: '原会话',
  ts: 1700000000000,
  runId: 'older-run',
  lastRunOutcome: 'completed',
  turns: [{ prompt: 'legacy turn body' }]
}

describe('incremental app session metadata', () => {
  it('imports field changes even with the same timestamp and imports a reverted version again', () => {
    withCatalogTest((sink, dir) => {
      const next = { ...entry, agentProfileId: 'work', cwd: '/tmp/新工作区', runId: 'newer-run', lastRunOutcome: 'failed' }
      const versions = [entry, next, entry]
      for (const [index, version] of versions.entries()) {
        const raw = JSON.stringify([version])
        writeFileSync(join(dir, 'app-sessions.json'), raw)
        const evidence = [`app-sessions:${sha256Hex(raw)}`]

        expect(importCatalogEntries(sink, dir, entry.ts + index, 1)).toMatchObject({ importedSessions: 1 })
        expect(sink.getSession('legacy')).toMatchObject({
          profile: version.agentProfileId,
          cwd: version.cwd,
          lastRunId: version.runId,
          lastRunOutcome: { quality: 'inferred', value: version.lastRunOutcome, source: evidence }
        })
        expect(sink.listEvents().at(-1)).toMatchObject({ type: 'session.imported', evidence })
        expect(importCatalogEntries(sink, dir, entry.ts + index + 10, 1).importedSessions).toBe(0)
      }
      const events = sink.listEvents()
      expect(events.map((event) => event.type)).toEqual(['session.imported', 'session.imported', 'session.imported'])
      expect(JSON.stringify(events)).not.toContain('legacy turn body')
      expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
    })
  })

  it('keeps projection edits when only a different catalog row changes', () => {
    withCatalogTest((sink, dir) => {
      const catalogPath = join(dir, 'app-sessions.json')
      writeFileSync(catalogPath, JSON.stringify([entry]))
      importCatalogEntries(sink, dir, entry.ts, 1)
      const payload = { sessionKey: 'legacy', title: '新标题' }
      expect(sink.execute({
        type: 'session.rename',
        commandId: 'rename-legacy',
        actor: 'system',
        scope: 'system',
        at: entry.ts + 1,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      }).kind).toBe('accepted')

      writeFileSync(catalogPath, JSON.stringify([entry, { ...entry, sessionId: 'other', lastRunOutcome: undefined }]))
      expect(importCatalogEntries(sink, dir, entry.ts + 2, 1).importedSessions).toBe(1)
      expect(sink.getSession('legacy')?.title).toBe('新标题')
      expect(sink.getSession('other')?.lastRunOutcome).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    })
  })
})
