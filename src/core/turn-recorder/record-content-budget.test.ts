import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAgentTurnRecord } from '../../shared/turn-record.js'
import type { ToolContent, ToolContentRef } from '../../shared/tool-content.js'
import { commitRecord } from './store.js'
import { readRecorderContent, writeRecorderContent } from './content-store.js'
import {
  CONTENT_ENVELOPE_REASON,
  RECORDER_CONTENT_MAX_BYTES,
  RECORDER_CONTENT_MAX_REFS,
  RECORDER_INLINE_PREVIEW_BYTES,
  RECORDER_TRANSPORT_MAX_BYTES,
  applyRecordContentBudget,
  recordContentRefs,
  recordTransportBytes
} from './record-content-budget.js'

/**
 * Acceptance oracle: the same rules the independent uploader applies before it sends a record
 * (`@ali/scry-uploader` 0.2.13 `src/content.ts`: contentReferences, validateContent, contentRecord).
 * Kept as a test mirror on purpose: the recorder must satisfy the receiver, not its own copy.
 */
const MAX_DECODED_RECORD_BYTES = 16 * 1024 * 1024
const MAX_CONTENT_BLOBS = 512

function transportRefs(recordJson: string): Map<string, { sha256: string; bytes: number; encoding: string }> {
  const refs = new Map<string, { sha256: string; bytes: number; encoding: string }>()
  const pending: unknown[] = [JSON.parse(recordJson)]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) { pending.push(...value); continue }
    const object = value as Record<string, unknown>
    if (object.storage === 'recorder-content-v1') {
      if (typeof object.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(object.sha256) ||
        !Number.isSafeInteger(object.bytes) || Number(object.bytes) < 0 || Number(object.bytes) > MAX_DECODED_RECORD_BYTES ||
        (object.encoding !== 'utf8' && object.encoding !== 'json')) throw new Error('invalid content reference')
      const ref = object as unknown as ToolContentRef
      const previous = refs.get(ref.sha256)
      if (previous && previous.bytes !== ref.bytes) throw new Error('conflicting content reference sizes')
      refs.set(ref.sha256, { sha256: ref.sha256, bytes: ref.bytes, encoding: ref.encoding })
      if (refs.size > MAX_CONTENT_BLOBS) throw new Error('content reference count exceeds 512')
    }
    pending.push(...Object.values(object))
  }
  return refs
}

function contentEnvelope(recordJson: string, contentJson: string): string {
  const record = JSON.stringify({ scryEncoding: 'recorder-content-v1', recordJson, contentJson })
  if (Buffer.byteLength(record) > MAX_DECODED_RECORD_BYTES) throw new Error('record and content exceed 16 MiB decoded limit')
  return record
}

function uploaderAccepts(recordJson: string, bodies: Map<string, string>): number {
  if (Buffer.byteLength(recordJson) > MAX_DECODED_RECORD_BYTES) throw new Error('record exceeds transport limit')
  const refs = transportRefs(recordJson)
  const blobs = [...refs.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)).map((ref) => {
    const text = bodies.get(ref.sha256)
    if (text === undefined) throw new Error(`content ${ref.sha256} is missing from the workspace store`)
    const raw = Buffer.from(text, 'utf8')
    if (raw.length !== ref.bytes || createHash('sha256').update(raw).digest('hex') !== ref.sha256) {
      throw new Error('content bytes do not match canonical reference')
    }
    return { sha256: ref.sha256, bytes: raw.length, dataBase64: raw.toString('base64') }
  })
  const contentJson = JSON.stringify(blobs)
  if (Buffer.byteLength(contentJson) > MAX_DECODED_RECORD_BYTES) throw new Error('content exceeds transport limit')
  return Buffer.byteLength(contentEnvelope(recordJson, contentJson))
}

// ---------------------------------------------------------------------------

const bodies = new Map<string, string>()

function body(text: string): ToolContentRef {
  const sha256 = createHash('sha256').update(text).digest('hex')
  bodies.set(sha256, text)
  return { storage: 'recorder-content-v1', sha256, bytes: Buffer.byteLength(text), encoding: 'utf8' }
}

function preview(text: string, bytes = 16): ToolContent {
  const content = text.slice(0, bytes)
  return {
    content, contentRef: body(text), encoding: 'utf8', savedBytes: Buffer.byteLength(content),
    source: 'fixture', sourceCompleteness: 'complete', redaction: 'disabled', storage: 'truncated', reasons: ['field_budget']
  }
}

const empty = () => ({ status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] })

function record(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    schemaVersion: 1, recordKind: 'agent_turn', sequence: 1, recordId: 'a'.repeat(32), recorderVersion: '0.2.67',
    workspace: { id: 'fixture', root: '/repo' }, provider: { id: 'codex' }, sessionId: 'session-1',
    generation: 1, turnIndex: 1, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000, status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y' } },
    tools: empty(), skills: empty(), mcps: empty(), hooks: empty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: empty(), diff: empty(), dangerousOperations: empty(), errors: empty(),
    ...overrides
  }
}

function withCalls(fields: ToolContent[]): Record<string, any> {
  return record({
    tools: {
      status: 'available', quality: 'exact', source: ['fixture'],
      value: fields.map((output, index) => ({ id: `call-${index}`, order: index, name: 'Bash', status: 'success', outputContent: output }))
    }
  })
}

function diffRecord(text: string): Record<string, any> {
  return record({
    diff: {
      status: 'available', quality: 'exact', source: ['fixture'],
      value: [{
        status: 'captured', files: [{ path: 'src/a.ts', added: 1, deleted: 0, patchStatus: 'captured', patchContent: preview(text, 1_000) }],
        beforeAt: '2026-01-01T00:00:00.000Z', afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok'
      }]
    }
  })
}

const roots: string[] = []
afterEach(async () => {
  bodies.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('record content budget at the shared commit boundary', () => {
  it('leaves a record that already fits byte-identical and still accepted', () => {
    const draft = withCalls([preview('a'.repeat(2_000)), preview('b'.repeat(2_000))])
    const bounded = applyRecordContentBudget(draft as never)
    expect(bounded).toBe(draft)
    expect(uploaderAccepts(JSON.stringify(bounded), bodies)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
  })

  it('keeps the first 512 distinct bodies and drops the 513th with an honest preview status', () => {
    const fields = Array.from({ length: RECORDER_CONTENT_MAX_REFS + 1 }, (_, index) => preview(`${index}:`.padEnd(64, 'z')))
    const draft = withCalls(fields)
    const bounded = applyRecordContentBudget(draft as never)
    expect(transportRefs(JSON.stringify(bounded)).size).toBe(RECORDER_CONTENT_MAX_REFS)
    const dropped = bounded.tools.value!.at(-1)!.outputContent!
    expect(dropped.contentRef).toBeUndefined()
    expect(dropped.storage).toBe('truncated')
    expect(dropped.reasons).toContain('turn_budget')
    expect(bounded.tools.status).toBe('partial')
    expect(bounded.tools.omissionReason).toContain(CONTENT_ENVELOPE_REASON)
    expect(isAgentTurnRecord(bounded)).toBe(true)
    uploaderAccepts(JSON.stringify(bounded), bodies)
  })

  it('drops a body above the per-content cap but keeps every other reference', () => {
    const huge = body('h'.repeat(RECORDER_CONTENT_MAX_BYTES + 1))
    const small = preview('small body')
    const draft = record({
      tools: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: [
          { id: 'huge', order: 0, name: 'Bash', status: 'success', outputContent: { ...huge, content: 'h', savedBytes: 1, source: 'fixture', sourceCompleteness: 'complete', redaction: 'disabled', storage: 'truncated', reasons: [] } },
          { id: 'small', order: 1, name: 'Bash', status: 'success', outputContent: small }
        ]
      }
    })
    const bounded = applyRecordContentBudget(draft as never)
    const refs = transportRefs(JSON.stringify(bounded))
    expect(refs.has(huge.sha256)).toBe(false)
    expect(refs.has(small.contentRef!.sha256)).toBe(true)
    expect(bounded.tools.value![0].outputContent.storage).toBe('truncated')
    expect(bounded.tools.value![1].outputContent.contentRef).toBeDefined()
  })

  it('measures base64 and JSON framing, not just raw bytes, when dropping bodies', () => {
    // 2 bodies of 7 MiB stay above the envelope only because base64 inflates them past 16 MiB.
    const six = 'q'.repeat(7 * 1024 * 1024)
    const draft = withCalls([preview(six), preview(`${six}!`)])
    expect(recordTransportBytes(draft as never)).toBeGreaterThan(RECORDER_TRANSPORT_MAX_BYTES)
    const bounded = applyRecordContentBudget(draft as never)
    expect(recordTransportBytes(bounded)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
    expect(transportRefs(JSON.stringify(bounded)).size).toBe(1)
    expect(uploaderAccepts(JSON.stringify(bounded), bodies)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
    expect(isAgentTurnRecord(bounded)).toBe(true)
  })

  it('drops a lost diff body to a bounded preview and keeps a reachable patch status', () => {
    // Two 6.5 MiB patches: each is under the per-body cap, but their base64 together exceed the envelope.
    const text = `@@ -1 +1 @@\n-${'old line\n'.repeat(660_000)}+${'new line\n'.repeat(50_000)}`
    const second = `${text}\n+tail`
    expect(Buffer.byteLength(text)).toBeLessThan(RECORDER_CONTENT_MAX_BYTES)
    const draft = record({
      diff: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: [{
          status: 'captured', files: [
            { path: 'src/a.ts', added: 1, deleted: 0, patchStatus: 'captured', patchContent: preview(text, 1_000) },
            { path: 'src/b.ts', added: 1, deleted: 0, patchStatus: 'captured', patchContent: preview(second, 1_000) }
          ],
          beforeAt: '2026-01-01T00:00:00.000Z', afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok'
        }]
      }
    })
    expect(recordTransportBytes(draft as never)).toBeGreaterThan(RECORDER_TRANSPORT_MAX_BYTES)
    const bounded = applyRecordContentBudget(draft as never)
    const files = bounded.diff.value![0].files
    const dropped = files.find((file) => file.patchContent?.contentRef === undefined)!
    const kept = files.find((file) => file.patchContent?.contentRef !== undefined)!
    expect(dropped.patchStatus).toBe('truncated')
    expect(Buffer.byteLength(dropped.patch!)).toBeLessThanOrEqual(RECORDER_INLINE_PREVIEW_BYTES)
    expect(dropped.patchContent!.content).toBe(dropped.patch)
    expect(bounded.diff.status).toBe('partial')
    expect(recordTransportBytes(bounded)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
    expect(isAgentTurnRecord(bounded)).toBe(true)
    uploaderAccepts(JSON.stringify(bounded), bodies)
  })

  it('bounds an oversized inline diff body even when it carries no reference', () => {
    // Quotes double under JSON escaping, so a 9 MiB body cannot fit the envelope without a reference.
    const content = '"'.repeat(9 * 1024 * 1024)
    const draft = record({
      diff: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: [{
          status: 'captured', files: [{
            path: 'src/a.ts', added: 1, deleted: 0, patchStatus: 'captured',
            patchContent: { content, encoding: 'utf8', savedBytes: content.length, source: 'fixture', sourceCompleteness: 'complete', redaction: 'disabled', storage: 'complete', reasons: [] }
          }],
          beforeAt: '2026-01-01T00:00:00.000Z', afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok'
        }]
      }
    })
    expect(recordTransportBytes(draft as never)).toBeGreaterThan(RECORDER_TRANSPORT_MAX_BYTES)
    const bounded = applyRecordContentBudget(draft as never)
    const file = bounded.diff.value![0].files[0]
    expect(Buffer.byteLength(file.patch!)).toBeLessThanOrEqual(RECORDER_INLINE_PREVIEW_BYTES)
    expect(file.patchContent!.storage).toBe('truncated')
    expect(file.patchStatus).toBe('truncated')
    // 这个 patch 现在只剩预览，diff 分区不能再声称 exact：证据状态必须跟着实际可读范围走。
    expect(bounded.diff.status).toBe('partial')
    expect(bounded.diff.quality).not.toBe('exact')
    expect(bounded.diff.omissionReason).toContain(CONTENT_ENVELOPE_REASON)
    expect(recordTransportBytes(bounded)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
    expect(isAgentTurnRecord(bounded)).toBe(true)
  }, 60_000)

  it('refuses to commit a record that cannot converge inside the envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-content-budget-'))
    roots.push(root)
    // 没有引用的内联正文只能靠收缩 diff 预览来减，装不下就别写进 store：接收方会拒收。
    const text = 'z'.repeat(RECORDER_TRANSPORT_MAX_BYTES + 1024)
    const draft = record({ assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text } } })
    expect(recordTransportBytes(draft as never)).toBeGreaterThan(RECORDER_TRANSPORT_MAX_BYTES)
    await expect(commitRecord(root, draft as never)).rejects.toThrow('above the transport envelope')
    expect(await readdir(join(root, 'records')).catch(() => [])).toEqual([])
  }, 60_000)

  it('counts the envelope wrapper even when nothing is referenced', () => {
    const draft = record({})
    // 没有引用时仍要把外层封装算进去：接收方量的是封装，不是裸 record 字符串。
    expect(recordTransportBytes(draft as never)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(draft)))
  })

  it('keeps a complete inline diff body and only drops its now-redundant reference', () => {
    const text = `@@ -1 +1 @@\n-${'old\n'.repeat(100)}+${'new\n'.repeat(100)}`
    const content = preview(text, Buffer.byteLength(text))
    const draft = record({
      diff: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: [{
          status: 'captured', files: [{ path: 'src/a.ts', added: 1, deleted: 0, patchStatus: 'captured', patchContent: { ...content, storage: 'complete', reasons: [] } }],
          beforeAt: '2026-01-01T00:00:00.000Z', afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok'
        }]
      }
    })
    // Force the drop by exceeding the distinct-body cap with unrelated bodies.
    draft.tools = withCalls(Array.from({ length: RECORDER_CONTENT_MAX_REFS }, (_, index) => preview(`${index}:`.padEnd(32, 'z')))).tools
    const bounded = applyRecordContentBudget(draft as never)
    const file = bounded.diff.value![0].files[0]
    expect(file.patchContent?.contentRef).toBeUndefined()
    expect(file.patchContent?.storage).toBe('complete')
    expect(file.patch).toBe(text)
    expect(file.patchStatus).toBe('captured')
    expect(isAgentTurnRecord(bounded)).toBe(true)
  })

  it('turns a dropped transcript body into unavailable evidence instead of a dangling reference', () => {
    const text = 'transcript range\n'.repeat(600_000)
    const draft = record({
      transcript: {
        status: 'available', quality: 'exact', source: ['provider_transcript'],
        value: { contentRef: body(text), sourcePath: '/tmp/s.jsonl', startOffset: 0, endOffset: Buffer.byteLength(text), identity: { dev: 1, ino: 2, size: Buffer.byteLength(text), mtimeMs: 3, ctimeMs: 4 }, sourceCompleteness: 'complete' }
      }
    })
    const bounded = applyRecordContentBudget(draft as never)
    expect(bounded.transcript!.value).toBeUndefined()
    expect(bounded.transcript!.status).toBe('unavailable')
    expect(bounded.transcript!.omissionReason).toBe(CONTENT_ENVELOPE_REASON)
    expect(isAgentTurnRecord(bounded)).toBe(true)
  })

  it('drops assistant and model-segment references while keeping their bounded inline text', () => {
    const assistantText = 'assistant preview'
    const segmentText = 'thinking preview'
    const draft = record({
      assistant: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: { text: assistantText, contentRefs: [body('assistant body '.repeat(300_000)), body('assistant body 2')] }
      },
      modelSegments: {
        status: 'available', quality: 'exact', source: ['fixture'],
        value: [{ order: 0, at: '2026-01-01T00:00:00.500Z', kind: 'thinking', text: segmentText, contentRefs: [body('thinking body '.repeat(300_000))] }]
      }
    })
    draft.tools = withCalls(Array.from({ length: RECORDER_CONTENT_MAX_REFS }, (_, index) => preview(`${index}:`.padEnd(32, 'z')))).tools
    const bounded = applyRecordContentBudget(draft as never)
    expect(transportRefs(JSON.stringify(bounded)).size).toBeLessThanOrEqual(RECORDER_CONTENT_MAX_REFS)
    expect(bounded.assistant.value!.text).toBe(assistantText)
    expect(bounded.modelSegments!.value![0].text).toBe(segmentText)
    expect(isAgentTurnRecord(bounded)).toBe(true)
    uploaderAccepts(JSON.stringify(bounded), bodies)
  })

  it('converges records around every boundary and stays acceptable to the uploader', () => {
    const sizes = [1, RECORDER_CONTENT_MAX_BYTES - 1, RECORDER_CONTENT_MAX_BYTES, RECORDER_CONTENT_MAX_BYTES + 1]
    for (const size of sizes) {
      for (const count of [1, 2, RECORDER_CONTENT_MAX_REFS, RECORDER_CONTENT_MAX_REFS + 1]) {
        const fields = Array.from({ length: count }, (_, index) => preview(`${size}:${index}:`.padEnd(Math.min(size, 4_096), 's')))
        const bounded = applyRecordContentBudget(withCalls(fields) as never)
        expect(isAgentTurnRecord(bounded)).toBe(true)
        uploaderAccepts(JSON.stringify(bounded), bodies)
      }
    }
  }, 120_000)

  it('keeps every reference the committed record still carries resolvable in the workspace store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-content-budget-'))
    roots.push(root)
    const bodies = ['a'.repeat(6 * 1024 * 1024), 'b'.repeat(6 * 1024 * 1024)]
    const refs = await Promise.all(bodies.map((text) => writeRecorderContent(root, text, 'utf8')))
    const bodies2 = refs.map((ref) => preview('body', 4))
    for (const [index, field] of bodies2.entries()) field.contentRef = refs[index]
    const { record: committed } = await commitRecord(root, withCalls(bodies2) as never)
    // 预算可能丢掉引用，但留下来的每一条都必须能在这个库里兑现。
    const kept = recordContentRefs(committed)
    expect(kept.length).toBeLessThan(refs.length)
    for (const ref of kept) await expect(readRecorderContent(root, ref)).resolves.toBe(bodies[refs.indexOf(ref)])
  }, 60_000)

  it('applies the same budget when the record is committed, and the stored record passes the uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-content-budget-'))
    roots.push(root)
    const six = 'c'.repeat(7 * 1024 * 1024)
    const { record: committed } = await commitRecord(root, withCalls([preview(six), preview(`${six}!`)]) as never)
    expect(committed.sequence).toBe(1)
    expect(recordTransportBytes(committed)).toBeLessThanOrEqual(RECORDER_TRANSPORT_MAX_BYTES)
    uploaderAccepts(JSON.stringify(committed), bodies)
  }, 120_000)
})
