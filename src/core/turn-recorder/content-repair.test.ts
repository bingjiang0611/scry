import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContent } from '../../shared/tool-content'
import { readRecorderContent, writeRecorderContent } from './content-store'
import { repairRecordContent } from './content-repair'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const body = (text: string): { content: string; ref: { storage: 'recorder-content-v1'; sha256: string; bytes: number; encoding: 'utf8' } } => ({
  content: text,
  ref: {
    storage: 'recorder-content-v1',
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    encoding: 'utf8'
  }
})

const content = (text: string, ref = body(text).ref): ToolContent => {
  const preview = text.slice(0, 8)
  return {
    content: preview,
    contentRef: ref,
    encoding: 'utf8',
    savedBytes: Buffer.byteLength(preview),
    source: 'fixture',
    sourceCompleteness: 'complete',
    redaction: 'disabled',
    storage: 'truncated',
    reasons: ['field_budget']
  }
}

const empty = () => ({ status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] })

function record(sequence: number, recordId: string, outputs: ToolContent[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    sequence,
    recordId,
    recorderVersion: '0.2.67',
    workspace: { id: 'fixture', root: '/repo' },
    provider: { id: 'pi' },
    sessionId: 'session-1',
    generation: sequence,
    turnIndex: sequence,
    startedAt: '2026-11-05T00:00:00.000Z',
    completedAt: '2026-11-05T00:00:01.000Z',
    durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'p' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'a' } },
    tools: {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: outputs.map((outputContent, index) => ({ id: `call-${index}`, name: 'Bash', status: 'success', outputContent }))
    },
    skills: empty(),
    mcps: empty(),
    hooks: empty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: empty(),
    diff: empty(),
    dangerousOperations: empty(),
    errors: empty()
  }
}

async function writeRecord(dataRoot: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(dataRoot, 'records'), { recursive: true })
  const name = `${String(value.sequence).padStart(20, '0')}-${String(value.recordId)}.json`
  await writeFile(join(dataRoot, 'records', name), JSON.stringify(value))
}

describe('recorder content repair', () => {
  it('dry run reports what it would copy and leaves the store untouched', async () => {
    const dataRoot = await tempRoot('scry-repair-store-')
    const appRoot = await tempRoot('scry-repair-app-')
    const present = body('present body')
    const appOnly = body('body that only the App store holds')
    const lost = body('body that no local store holds')
    await writeRecorderContent(dataRoot, present.content, 'utf8')
    await writeRecorderContent(appRoot, appOnly.content, 'utf8')
    await writeRecord(dataRoot, record(1, 'a'.repeat(32), [content('present body'), content('body that only the App store holds')]))
    await writeRecord(dataRoot, record(2, 'b'.repeat(32), [content('body that no local store holds')]))
    const before = await readdir(join(dataRoot, 'content', 'sha256'))
    const beforeRecords = await Promise.all((await readdir(join(dataRoot, 'records'))).map((name) => readFile(join(dataRoot, 'records', name), 'utf8')))

    const report = await repairRecordContent({ dataRoot, sourceRoots: [appRoot] })

    expect(report).toMatchObject({
      applied: false,
      records: 2,
      refs: 3,
      present: 1,
      repairable: 1,
      missing: 1,
      repaired: 0,
      bytes: appOnly.ref.bytes,
      sources: [appRoot]
    })
    expect(report.missingItems).toEqual([
      { recordId: 'b'.repeat(32), path: 'tools.0.output', sha256: lost.ref.sha256, bytes: lost.ref.bytes }
    ])
    // Nothing was written: the dry run is a plan, not a mutation.
    await expect(readRecorderContent(dataRoot, appOnly.ref)).rejects.toThrow()
    expect(await readdir(join(dataRoot, 'content', 'sha256'))).toEqual(before)
    expect(await Promise.all((await readdir(join(dataRoot, 'records'))).map((name) => readFile(join(dataRoot, 'records', name), 'utf8')))).toEqual(beforeRecords)
  })

  it('--apply copies verified bytes into the workspace store and leaves records untouched', async () => {
    const dataRoot = await tempRoot('scry-repair-store-')
    const appRoot = await tempRoot('scry-repair-app-')
    const appOnly = body('repairable body')
    await writeRecorderContent(appRoot, appOnly.content, 'utf8')
    await writeRecord(dataRoot, record(1, 'c'.repeat(32), [content('repairable body')]))
    const recordsBefore = await readFile(join(dataRoot, 'records', `00000000000000000001-${'c'.repeat(32)}.json`), 'utf8')

    const report = await repairRecordContent({ dataRoot, sourceRoots: [appRoot], apply: true })

    expect(report).toMatchObject({ applied: true, records: 1, refs: 1, present: 0, repairable: 1, missing: 0, repaired: 1 })
    await expect(readRecorderContent(dataRoot, appOnly.ref)).resolves.toBe(appOnly.content)
    expect(await readFile(join(dataRoot, 'records', `00000000000000000001-${'c'.repeat(32)}.json`), 'utf8')).toBe(recordsBefore)
  })

  it('ignores a source body whose digest does not match the reference', async () => {
    const dataRoot = await tempRoot('scry-repair-store-')
    const appRoot = await tempRoot('scry-repair-app-')
    const appOnly = body('the real body')
    // Same path, same length, different bytes: a verified read must refuse it.
    const path = join(appRoot, 'content', 'sha256', appOnly.ref.sha256.slice(0, 2), `${appOnly.ref.sha256}.bin`)
    await mkdir(join(appRoot, 'content', 'sha256', appOnly.ref.sha256.slice(0, 2)), { recursive: true })
    await writeFile(path, 'x'.repeat(appOnly.ref.bytes))
    await writeRecord(dataRoot, record(1, 'd'.repeat(32), [content('the real body')]))

    const report = await repairRecordContent({ dataRoot, sourceRoots: [appRoot], apply: true })

    expect(report).toMatchObject({ repairable: 0, missing: 1, repaired: 0, bytes: 0 })
    expect(report.missingItems).toHaveLength(1)
    await expect(readRecorderContent(dataRoot, appOnly.ref)).rejects.toThrow()
  })

  it('--record-id narrows the work and an unknown id fails instead of being skipped', async () => {
    const dataRoot = await tempRoot('scry-repair-store-')
    const first = body('first body')
    const second = body('second body')
    await writeRecorderContent(dataRoot, first.content, 'utf8')
    await writeRecorderContent(dataRoot, second.content, 'utf8')
    await writeRecord(dataRoot, record(1, 'e'.repeat(32), [content('first body'), content('absent from every store')]))
    await writeRecord(dataRoot, record(2, 'f'.repeat(32), [content('second body')]))

    const report = await repairRecordContent({ dataRoot, sourceRoots: [], recordIds: ['e'.repeat(32)] })
    expect(report).toMatchObject({ records: 1, refs: 2, present: 1, repairable: 0, missing: 1 })
    expect(report.missingItems.map((item) => item.recordId)).toEqual(['e'.repeat(32)])

    await expect(repairRecordContent({ dataRoot, sourceRoots: [], recordIds: ['nothing'] })).rejects.toThrow('record not found: nothing')
  })

  it('only counts conforming records and reports what it skipped', async () => {
    const dataRoot = await tempRoot('scry-repair-store-')
    const present = body('present body')
    await writeRecorderContent(dataRoot, present.content, 'utf8')
    await writeRecord(dataRoot, record(1, 'a1'.repeat(16), [content('present body')]))
    // 写盘中辍的两种残留：永不 rename 上屏的 `.tmp`，以及名字合规但内容不完整的文件。
    const leftover = `00000000000000002328-${'a2'.repeat(16)}.json.4242.6f1e.tmp`
    const truncated = `00000000000000000002-${'a3'.repeat(16)}.json`
    await writeFile(join(dataRoot, 'records', leftover), '')
    await writeFile(join(dataRoot, 'records', truncated), '{"schemaVersion":1}')

    const report = await repairRecordContent({ dataRoot, sourceRoots: [], apply: true })

    expect(report).toMatchObject({ records: 1, refs: 1, present: 1, missing: 0 })
    expect(report.skipped).toEqual([
      { name: truncated, reason: 'unreadable_record' },
      { name: leftover, reason: 'unrecognized_name' }
    ])
    // 跳过不等于删除：修复工具只补正文，存库卫生属于维护命令。
    expect(await readdir(join(dataRoot, 'records'))).toContain(leftover)
  })
})
