import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraceEvent } from '../shared/trace'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { mergeSessionTurns } from './session-history'
import type { TraceArchive } from './transcript-archive'
import { persistTraceToolEvents, readAppTraceContentPage } from './trace-tool-content'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const event = (output: string): TraceEvent => ({
  id: 'large-result', runId: 'run', ts: '2026-09-21T00:00:00.000Z', kind: 'tool', stage: 'tool_result',
  toolUseId: 'call', output, text: output
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-trace-content-'))
  roots.push(root)
  return root
}

describe('App trace content projection', () => {
  it('keeps >10MiB results bounded without a recorder and pages the complete original only in its workspace', async () => {
    const root = await fixture()
    const output = JSON.stringify({ details: { value: '界面'.repeat(2_000_000) }, tail: 'complete-tail' })
    const [bounded] = await persistTraceToolEvents(root, '/known/project', [event(output)])
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(32 * 1024)
    const ref = bounded.outputContent!.contentRef!
    expect(ref.bytes).toBeGreaterThan(10 * 1024 * 1024)
    expect(bounded.outputContent?.source).toBe('scry_app_trace')
    const pages: Buffer[] = []
    let offset = 0
    do {
      const page = await readAppTraceContentPage(root, '/known/project', { source: 'app-trace', ref, offset })
      expect(page.nextOffset - page.offset).toBeLessThanOrEqual(64 * 1024)
      pages.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.nextOffset
    } while (offset < ref.bytes)
    expect(Buffer.concat(pages).toString('utf8')).toBe(output)
    await expect(readAppTraceContentPage(root, '/foreign/project', { source: 'app-trace', ref })).rejects.toThrow()
    await expect(readAppTraceContentPage(root, '/known/project', { source: 'app-trace', ref: { ...ref, sha256: '../escape' } })).rejects.toThrow('invalid_trace_content_ref')
    await expect(readAppTraceContentPage(root, '/known/project', { source: 'app-trace', ref, limit: 65537 })).rejects.toThrow('invalid_trace_content_limit')
    await expect(readAppTraceContentPage(root, '/known/project', { source: 'app-trace', ref, offset: -1 })).rejects.toThrow()
  })

  it('normalizes legacy history without changing archived bytes and keeps managed records independently readable', async () => {
    const root = await fixture()
    const output = 'legacy-body'.repeat(100_000)
    const archive: TraceArchive = { version: 3, cwd: '/repo', sessionId: 'session', providerId: 'pi',
      turns: [{ runId: 'run', userText: 'inspect', items: [event(output)], done: true, ts: 1 }] }
    const path = join(root, 'archive.json')
    const original = JSON.stringify(archive)
    await writeFile(path, original)
    const loaded = JSON.parse(await readFile(path, 'utf8')) as TraceArchive
    loaded.turns[0].items = await persistTraceToolEvents(root, '/repo', loaded.turns[0].items, join(root, 'recorder'))
    const [turn] = mergeSessionTurns([], loaded)
    expect(Buffer.byteLength(JSON.stringify(loaded))).toBeLessThan(32 * 1024)
    expect(Buffer.byteLength(JSON.stringify(turn))).toBeLessThan(32 * 1024)
    const ref = turn.items[0].outputContent!.contentRef!
    expect(await readRecorderContent(join(root, 'recorder'), ref)).toBe(output)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await persistTraceToolEvents(root, '/repo', loaded.turns[0].items)).toEqual(loaded.turns[0].items)
  })
})
