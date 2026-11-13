import { describe, expect, it } from 'vitest'
import type { DiffFile } from '@shared/trace'
import { allocateDiffPatches, STACK_PATCH_CHARACTER_LIMIT } from './diff-stack'
import { diffBodyItem, emptyDiffItem, parseDiffBody } from './pierre-diff'

const file = (path: string, patch?: string): DiffFile => ({ path, patch, added: 1, deleted: 1 })
const patch = '@@ -4,2 +8,3 @@\n-old one\n-old two\n+new one\n+new two\n+new three\n'
const allocate = (files: DiffFile[], selected = files[0].path, collapsed = new Set<string>()) => allocateDiffPatches(files, selected, collapsed)

describe('Pierre patch projection', () => {
  it('preserves unequal replacements and old/new line offsets', () => {
    const body = parseDiffBody(patch, 'a.ts')
    expect(body.kind).toBe('diff')
    if (body.kind !== 'diff') throw new Error(body.error)
    expect(body.fileDiff.deletionLines).toEqual(['old one\n', 'old two\n'])
    expect(body.fileDiff.additionLines).toEqual(['new one\n', 'new two\n', 'new three\n'])
    expect(body.fileDiff.hunks[0]).toMatchObject({ deletionStart: 4, deletionCount: 2, additionStart: 8, additionCount: 3 })
  })
  it('does not confuse header-looking source with file headers', () => {
    const body = parseDiffBody('--- a/file\n+++ b/file\n@@ -1,2 +1,3 @@\n---old\n+++new\n stay\n+added\n', 'file')
    expect(body.kind).toBe('diff')
    if (body.kind !== 'diff') throw new Error(body.error)
    expect(body.fileDiff.deletionLines).toContain('--old\n')
    expect(body.fileDiff.additionLines).toContain('++new\n')
    expect(body.fileDiff.additionLines).toContain('added\n')
  })
  it('retains only supplied context and keeps gaps between hunks partial', () => {
    const source = '@@ -1,10 +1,10 @@\n' + Array.from({ length: 10 }, (_, i) => ` context ${i}\n`).join('') + '@@ -100 +100 @@\n-a\n+b\n'
    const body = parseDiffBody(source, 'file')
    expect(body.kind).toBe('diff')
    if (body.kind !== 'diff') throw new Error(body.error)
    expect(body.fileDiff.isPartial).toBe(true)
    expect(body.fileDiff.hunks).toHaveLength(2)
    expect(body.fileDiff.additionLines).toHaveLength(11)
    expect(body.fileDiff.hunks[1].additionStart).toBe(100)
  })
  it('preserves invalid patches as raw evidence rather than assigning guessed line comments', () => {
    const text = '@@ -1,99 +1,99 @@\n-old\n+new\n'
    const body = parseDiffBody(text, 'file')
    expect(body).toMatchObject({ kind: 'raw', text })
    expect(diffBodyItem('file', body)).toMatchObject({ type: 'file', file: { contents: text, lang: 'diff' } })
  })
  it('keeps unchanged body revisions stable and publishes a new revision for refreshed evidence', () => {
    const body = parseDiffBody(patch, 'file.ts')
    const first = diffBodyItem('file.ts', body)
    expect(diffBodyItem('file.ts', body).version).toBe(first.version)
    expect(diffBodyItem('file.ts', parseDiffBody(patch.replace('new three', 'refreshed'), 'file.ts')).version).not.toBe(first.version)
    expect(emptyDiffItem('file.ts').version).toBe(0)
  })
  it('uses a header-only partial model for unavailable evidence, never a synthetic body', () => {
    expect(emptyDiffItem('missing')).toMatchObject({ collapsed: true, fileDiff: { isPartial: true, hunks: [], additionLines: [], deletionLines: [] } })
  })
  it('retains every file and original evidence when collapsed', () => {
    const files = [file('/repo/a', patch), file('/repo/b', patch)]
    expect(allocate(files, '/repo/a', new Set(['/repo/a']))).toEqual([
      { file: files[0], text: '', notices: [] }, { file: files[1], text: patch, notices: [] }
    ])
    expect(files[0].patch).toBe(patch)
  })
  it('keeps missing, binary, truncated and retained content distinct', () => {
    const files: DiffFile[] = [file('missing'), { ...file('binary'), binary: true },
      { ...file('partial', patch), patchStatus: 'truncated' },
      { ...file('retained', 'wrong preview'), patchStatus: 'truncated', patchContent: { storage: 'complete', content: patch, encoding: 'utf8', savedBytes: patch.length, source: 'git', redaction: 'unchanged', reasons: [], sourceCompleteness: 'complete' } }]
    const result = allocate(files)
    expect(result.map(entry => entry.notices)).toEqual([['missing'], ['binary'], ['partial'], []])
    expect(result[3].text).toBe(patch)
  })
  it.each(['legacy', 'content-only'] as const)('uses %s inline evidence without a reference fetch', shape => {
    const entry: DiffFile = { path: 'inline', added: 3, deleted: 2, patchStatus: 'captured', ...(shape === 'legacy' ? { patch } : {}),
      patchContent: { storage: 'complete', content: patch, encoding: 'utf8', savedBytes: patch.length, source: 'git_turn_diff', redaction: 'disabled', reasons: [], sourceCompleteness: 'complete' } }
    expect(allocate([entry])[0]).toEqual({ file: entry, text: patch, notices: [] })
  })
  it('uses hydrated reference-only content but never treats a missing reference as an empty patch', () => {
    const entry: DiffFile = { ...file('restored', patch), patchStatus: 'truncated', patchContent: { storage: 'complete', content: '',
      contentRef: { storage: 'recorder-content-v1', sha256: 'a'.repeat(64), bytes: patch.length, encoding: 'utf8' },
      encoding: 'utf8', savedBytes: 0, source: 'scry_app_trace', redaction: 'not_run', reasons: [], sourceCompleteness: 'complete' } }
    expect(allocate([entry])[0]).toMatchObject({ text: patch, notices: [] })
    expect(allocate([{ ...entry, patch: undefined }])[0].notices).toEqual(['missing', 'partial'])
  })
  it('keeps complete storage separate from partial source', () => {
    const entry: DiffFile = { ...file('partial-source'), patchContent: { storage: 'complete', content: patch,
      encoding: 'utf8', savedBytes: patch.length, source: 'git', redaction: 'unchanged', reasons: ['source_truncated'], sourceCompleteness: 'partial' } }
    expect(allocate([entry])[0]).toMatchObject({ text: patch, notices: ['sourcePartial'] })
  })
  it('bounds all-file allocation and gives the selected file priority without dropping headers', () => {
    const huge = '@@ -1 +1 @@\n+' + 'a'.repeat(STACK_PATCH_CHARACTER_LIMIT) + '\n'
    const files = [file('large', huge), file('selected', patch), ...Array.from({ length: 1000 }, (_, index) => file(`file-${index}`, huge))]
    const result = allocate(files, 'selected')
    expect(result).toHaveLength(1002)
    expect(result[1].text).toBe(patch)
    expect(result.some(entry => entry.notices.includes('limit'))).toBe(true)
    expect(result.reduce((size, entry) => size + (entry.text?.length ?? 0), 0)).toBeLessThanOrEqual(STACK_PATCH_CHARACTER_LIMIT)
  })
})
