import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContent } from '../../shared/tool-content'
import type { TurnCall, TurnEvidence } from '../../shared/turn-record'
import { available, unavailable } from '../../shared/turn-record'
import { readRecorderContent, writeRecorderContent } from './content-store'
import { CONTENT_MISSING_REASON, resolveRecordContentRefs } from './managed-capture'

const roots: string[] = []
const dataRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'scry-record-refs-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const completeBody = (text: string): ToolContent => ({
  content: text,
  encoding: 'json',
  savedBytes: Buffer.byteLength(text),
  source: 'scry_app_trace',
  sourceCompleteness: 'complete',
  redaction: 'disabled',
  storage: 'complete',
  reasons: []
})

const call = (id: string, input: ToolContent, output?: ToolContent): TurnCall => ({
  id,
  name: 'Bash',
  status: 'completed',
  ...(input ? { inputContent: input } : {}),
  ...(output ? { outputContent: output } : {}),
  ...(output ? { outputSummary: 'summary' } : {})
})

const evidence = (tools: TurnCall[]): TurnEvidence => ({
  user: available({ text: 'run the check' }, ['test']),
  assistant: available({ text: 'done' }, ['test']),
  tools: available(tools, ['test']),
  skills: unavailable('no skills recorded'),
  mcps: unavailable('no MCP evidence'),
  hooks: unavailable('no hooks recorded'),
  usage: unavailable('no usage recorded'),
  files: available([], ['test']),
  diff: available([], ['test']),
  dangerousOperations: available([], ['test']),
  errors: available([], ['test'])
})

describe('resolveRecordContentRefs', () => {
  it('leaves a record unchanged when every reference resolves in this store', async () => {
    const store = await dataRoot()
    const body = '{"command":"ls -la"}'
    const ref = await writeRecorderContent(store, body, 'json')
    const record = evidence([call('call-1', { ...completeBody(body), content: undefined, contentRef: ref })])

    const resolved = await resolveRecordContentRefs(record, store)

    expect(resolved.resolution).toEqual({ restored: 0, unavailable: 0 })
    expect(resolved.record).toEqual(record)
  })

  it('writes the inline body back into this store when the reference has no bytes here', async () => {
    const store = await dataRoot()
    const body = '{"command":"ls -la"}'
    // The reference was published by another authority (the App trace store): bytes are not here.
    const foreignRef = { storage: 'recorder-content-v1' as const, sha256: 'a'.repeat(64), bytes: 1, encoding: 'json' as const }
    const record = evidence([call('call-1', { ...completeBody(body), contentRef: foreignRef })])

    const resolved = await resolveRecordContentRefs(record, store)

    expect(resolved.resolution).toEqual({ restored: 1, unavailable: 0 })
    const kept = resolved.record.tools.value![0].inputContent!
    expect(kept.storage).toBe('complete')
    expect(kept.contentRef?.sha256).not.toBe(foreignRef.sha256)
    // The record's new reference resolves in this store: that is the invariant the uploader needs.
    await expect(readRecorderContent(store, kept.contentRef!)).resolves.toBe(body)
  })

  it('degrades to unavailable instead of committing a dangling reference', async () => {
    const store = await dataRoot()
    const missing = { storage: 'recorder-content-v1' as const, sha256: 'b'.repeat(64), bytes: 9, encoding: 'utf8' as const }
    const truncated: ToolContent = {
      ...completeBody('preview'),
      content: 'preview',
      savedBytes: 7,
      storage: 'truncated',
      contentRef: missing
    }
    const record = evidence([call('call-1', completeBody('{"command":"ls"}'), truncated)])

    const resolved = await resolveRecordContentRefs(record, store)

    // The output body is gone (degraded); the inline input body gains a local reference.
    expect(resolved.resolution).toEqual({ restored: 1, unavailable: 1 })
    const output = resolved.record.tools.value![0].outputContent!
    expect(output.contentRef).toBeUndefined()
    expect(output.content).toBeUndefined()
    expect(output.storage).toBe('omitted')
    expect(output.sourceCompleteness).toBe('unavailable')
    expect(output.savedBytes).toBe(0)
    expect(resolved.record.tools.value![0].outputSummary).toBeUndefined()
    expect(resolved.record.tools.status).toBe('partial')
    expect(resolved.record.tools.quality).toBe('inferred')
    expect(resolved.record.tools.omissionReason).toContain(CONTENT_MISSING_REASON)
    // No reference survived the degradation, so the committed record cannot point outside this store.
    const stored = await readFile(join(store, 'content', 'sha256', missing.sha256.slice(0, 2), `${missing.sha256}.bin`), 'utf8')
      .catch(() => undefined)
    expect(stored).toBeUndefined()
  })
})
