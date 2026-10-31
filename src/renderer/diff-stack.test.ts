import { describe, expect, it } from 'vitest'
import type { DiffFile } from '@shared/trace'
import { buildDiffStack, codeRows, STACK_PATCH_CHARACTER_LIMIT } from './diff-stack'

const file = (path: string, patch?: string): DiffFile => ({ path, patch, added: 1, deleted: 1 })
const patch = '@@ -4,2 +8,3 @@\n-old one\n-old two\n+new one\n+new two\n+new three\n'

describe('stacked patch projection', () => {
  it('pairs unequal replacement blocks without inventing line numbers', () => {
    const rows = codeRows(patch, 'split', new Set())
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatchObject({ kind: 'pair', left: { oldLine: 4, text: '-old one' }, right: { newLine: 8, text: '+new one' } })
    expect(rows[2]).toMatchObject({ kind: 'pair', left: { oldLine: 5 }, right: { newLine: 9 } })
    expect(rows[3]).toEqual({ kind: 'pair', left: undefined, right: { kind: 'add', newLine: 10, text: '+new three' } })
  })
  it('does not confuse header-looking source lines, isolated additions or separated changes', () => {
    const rows = codeRows('--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n+++new\n---old\n stay\n+added', 'split', new Set())
    expect(rows[1]).toMatchObject({ kind: 'pair', right: { text: '+++new', newLine: 1 } })
    expect(rows[2]).toMatchObject({ kind: 'pair', left: { text: '---old', oldLine: 1 } })
    expect(rows[3]).toMatchObject({ kind: 'line', line: { kind: 'context', oldLine: 2, newLine: 2 } })
    expect(rows[4]).toMatchObject({ kind: 'pair', right: { text: '+added', newLine: 3 } })
  })
  it('collapses and expands only supplied context; gaps between hunks remain gaps', () => {
    const source = '@@ -1,10 +1,10 @@\n' + Array.from({ length: 10 }, (_, i) => ` context ${i}\n`).join('') + '@@ -100 +100 @@\n-a\n+b\n'
    const collapsed = codeRows(source, 'unified', new Set())
    expect(collapsed[4]).toEqual({ kind: 'context', id: 1, count: 4 })
    const expanded = codeRows(source, 'unified', new Set([1]))
    expect(expanded).toHaveLength(14)
    expect(expanded.filter(row => row.kind === 'context')).toHaveLength(0)
    expect(expanded[11]).toMatchObject({ kind: 'line', line: { kind: 'hunk', text: '@@ -100 +100 @@' } })
    expect(codeRows(source, 'unified', new Set([-1]))).toEqual(expanded)
  })
  it('stacks every file and preserves original patch evidence when one is collapsed', () => {
    const files = [file('/repo/a', patch), file('/repo/b', '@@ -1 +1 @@\n-x\n+y')]
    const stack = buildDiffStack(files, 'unified', new Set(['/repo/a']), new Map(), '/repo/a')
    expect(stack.rows[0]).toMatchObject({ kind: 'file', file: files[0] })
    expect(stack.starts.get('/repo/b')).toBe(1)
    expect(stack.rows.filter(row => row.kind === 'code')).toHaveLength(3)
    expect(files[0].patch).toBe(patch)
  })
  it('keeps missing, binary, truncated and complete retained content distinct', () => {
    const files: DiffFile[] = [file('missing'), { ...file('binary'), binary: true },
      { ...file('partial', patch), patchStatus: 'truncated' },
      { ...file('retained', 'wrong preview'), patchStatus: 'truncated', patchContent: { storage: 'complete', content: patch, encoding: 'utf8', savedBytes: patch.length, source: 'git', redaction: 'unchanged', reasons: [], sourceCompleteness: 'complete' } }]
    const stack = buildDiffStack(files, 'unified', new Set(), new Map(), 'missing')
    expect(stack.rows.filter(row => row.kind === 'notice').map(row => row.kind === 'notice' && [row.file.path, row.reason]))
      .toEqual([['missing', 'missing'], ['binary', 'binary'], ['partial', 'partial']])
    expect(JSON.stringify(stack.rows)).not.toContain('"text":"wrong preview"')
  })
  it('uses hydrated patches when complete content is stored by reference only', () => {
    const entry: DiffFile = { ...file('restored', patch), patchStatus: 'truncated', patchContent: { storage: 'complete', content: '',
      contentRef: { storage: 'recorder-content-v1', sha256: 'a'.repeat(64), bytes: patch.length, encoding: 'utf8' },
      encoding: 'utf8', savedBytes: 0, source: 'scry_app_trace', redaction: 'not_run', reasons: [], sourceCompleteness: 'complete' } }
    const stack = buildDiffStack([entry], 'unified', new Set(), new Map(), entry.path)
    expect(stack.rows.some(row => row.kind === 'code' && row.row.kind === 'line' && row.row.line.text === '+new three')).toBe(true)
    expect(stack.rows.some(row => row.kind === 'notice')).toBe(false)
    const missing = { ...entry, patch: undefined }
    expect(buildDiffStack([missing], 'unified', new Set(), new Map(), missing.path).rows)
      .toContainEqual({ kind: 'notice', file: missing, reason: 'missing' })
  })
  it('does not confuse complete storage with a complete source', () => {
    const entry: DiffFile = { ...file('partial-source'), patchContent: { storage: 'complete', content: patch,
      encoding: 'utf8', savedBytes: patch.length, source: 'git', redaction: 'unchanged', reasons: ['source_truncated'], sourceCompleteness: 'partial' } }
    const stack = buildDiffStack([entry], 'unified', new Set(), new Map(), entry.path)
    expect(stack.rows.some(row => row.kind === 'code')).toBe(true)
    expect(stack.rows).toContainEqual({ kind: 'notice', file: entry, reason: 'sourcePartial' })
  })
  it('bounds all-file parsing and prioritizes an explicitly selected file without dropping file headers', () => {
    const huge = '@@ -1 +1 @@\n+' + 'a'.repeat(STACK_PATCH_CHARACTER_LIMIT) + '\n'
    const files = [file('large', huge), file('selected', patch), ...Array.from({ length: 1000 }, (_, index) => file(`file-${index}`, huge))]
    const stack = buildDiffStack(files, 'unified', new Set(), new Map(), 'selected')
    expect(stack.rows.filter(row => row.kind === 'file')).toHaveLength(1002)
    expect(stack.rows.some(row => row.kind === 'code' && row.file.path === 'selected' && row.row.kind === 'line' && row.row.line.text === '+new three')).toBe(true)
    expect(stack.rows.some(row => row.kind === 'notice' && row.reason === 'limit')).toBe(true)
    expect(stack.rows.length).toBeLessThan(4000)
  })
})
