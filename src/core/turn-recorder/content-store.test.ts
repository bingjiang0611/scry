import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace.js'
import { isToolContent } from '../../shared/tool-content.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { readRecorderContent, readRecorderContentPage, writeRecorderContent } from './content-store.js'
import { captureToolContent, persistToolEventContent } from './tool-content.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'scry-content-store-'))
  roots.push(path)
  return path
}

function events(output: string): TraceEvent[] {
  return [
    { id: 'start', runId: 'run', ts: '2026-01-01T00:00:00Z', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'call', input: { command: 'printf hello' } },
    { id: 'result', runId: 'run', ts: '2026-01-01T00:00:01Z', kind: 'tool', stage: 'tool_result', toolUseId: 'call', output }
  ]
}

const policy = { toolOutput: 'full-redacted' as const, toolContentFieldBytes: 64, toolContentTurnBytes: 64 }

describe('recorder content store', () => {
  it('persists complete redacted content while keeping the inline record bounded', async () => {
    const dataRoot = await root()
    const secret = 'SECRET_AFTER_PREVIEW'
    const exposed = `${'正文😀'.repeat(200)}\nAuthorization: Bearer ${secret}\nTAIL`
    const persisted = await persistToolEventContent(events(exposed), policy, 'fixture', (content, encoding) =>
      writeRecorderContent(dataRoot, content, encoding))
    const field = persisted[1].outputContent!

    expect(field.savedBytes).toBeLessThanOrEqual(64)
    expect(field.storage).toBe('truncated')
    expect(field.contentRef).toMatchObject({ storage: 'recorder-content-v1', encoding: 'utf8' })
    expect(isToolContent(field)).toBe(true)
    const complete = await readRecorderContent(dataRoot, field.contentRef!)
    expect(complete).toBe(captureToolContent(exposed, { source: 'fixture', maxBytes: null }).content)
    expect(complete).toContain('TAIL')
    expect(complete).toContain('[REDACTED]')
    expect(complete).not.toContain(secret)
    expect(Buffer.byteLength(complete)).toBe(field.contentRef!.bytes)

    const evidence = aggregateTurnEvidence({ events: persisted, toolContentPolicy: policy })
    expect(evidence.tools.status).toBe('available')
    expect(evidence.tools.omissionReason).toBeUndefined()
    expect(evidence.tools.value![0].outputContent?.contentRef).toEqual(field.contentRef)
  })

  it('keeps a reference when a later turn budget truncates a small field', async () => {
    const dataRoot = await root()
    const persisted = await persistToolEventContent(events('small complete body'), {
      toolOutput: 'full-redacted', toolContentFieldBytes: 1024, toolContentTurnBytes: 4
    }, 'fixture', (content, encoding) => writeRecorderContent(dataRoot, content, encoding))
    expect(persisted[1].outputContent).toMatchObject({ storage: 'complete', contentRef: { bytes: 19 } })

    const call = aggregateTurnEvidence({
      events: persisted,
      toolContentPolicy: { toolOutput: 'full-redacted', toolContentFieldBytes: 1024, toolContentTurnBytes: 4 }
    }).tools.value![0]
    expect(call.outputContent).toMatchObject({ storage: 'omitted', savedBytes: 0, contentRef: { bytes: 19 } })
    expect(await readRecorderContent(dataRoot, call.outputContent!.contentRef!)).toBe('small complete body')
  })

  it('reads exact bounded byte pages while verifying the complete artifact', async () => {
    const dataRoot = await root()
    const content = `${'中😀'.repeat(30_000)}TAIL`
    const ref = await writeRecorderContent(dataRoot, content, 'utf8')
    const pages: Buffer[] = []
    let offset = 0
    do {
      const page = await readRecorderContentPage(dataRoot, ref, { offset, limit: 32_767 })
      expect(Buffer.from(page.dataBase64, 'base64')).toHaveLength(page.nextOffset - page.offset)
      pages.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (true)
    expect(Buffer.concat(pages).toString('utf8')).toBe(content)
    const path = join(dataRoot, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
    await writeFile(path, 'tampered after cached verification')
    await expect(readRecorderContentPage(dataRoot, ref, { offset: 0, limit: 8 })).rejects.toThrow('integrity check failed')
    await expect(readRecorderContentPage(dataRoot, ref, { offset: ref.bytes + 1 })).rejects.toThrow('offset')
    await expect(readRecorderContentPage(dataRoot, ref, { limit: 256 * 1024 + 1 })).rejects.toThrow('limit')
  })

  it('deduplicates by digest and verifies content after a later read', async () => {
    const dataRoot = await root()
    const first = await writeRecorderContent(dataRoot, 'same content', 'utf8')
    const second = await writeRecorderContent(dataRoot, 'same content', 'utf8')
    expect(second).toEqual(first)
    expect(await readRecorderContent(dataRoot, first)).toBe('same content')
    expect(await readdir(join(dataRoot, 'content', 'sha256', first.sha256.slice(0, 2)))).toEqual([`${first.sha256}.bin`])
  })

  it('fails explicitly on unavailable storage and corrupted referenced bytes', async () => {
    const dataRoot = await root()
    await writeFile(join(dataRoot, 'content'), 'not a directory')
    await expect(writeRecorderContent(dataRoot, 'cannot persist', 'utf8')).rejects.toBeDefined()

    const healthyRoot = await root()
    const ref = await writeRecorderContent(healthyRoot, 'original', 'utf8')
    const path = join(healthyRoot, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
    await writeFile(path, 'tampered')
    await expect(readRecorderContent(healthyRoot, ref)).rejects.toThrow('integrity check failed')
    await rm(path)
    await expect(readRecorderContent(healthyRoot, ref)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
