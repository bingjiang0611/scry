import { describe, expect, it } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { parseDiffBody } from './pierre-diff'
import { foldCapturedContext } from './pierre-context'

function parse(patch: string): FileDiffMetadata {
  const body = parseDiffBody(patch, 'captured.ts')
  if (body.kind !== 'diff') throw new Error(body.error)
  return body.fileDiff
}

const captured = '@@ -1,10 +1,10 @@\n' + Array.from({ length: 10 }, (_, i) => ` context-${i}\n`).join('') + '@@ -100 +100 @@\n-before\n+after\n'

describe('captured context folding', () => {
  it('folds only captured lines and preserves original offsets, gaps and partial provenance', () => {
    const original = parse(captured)
    const before = JSON.stringify(original)
    const result = foldCapturedContext(original)
    expect(result.hidden).toBe(4)
    expect(result.fileDiff.isPartial).toBe(true)
    expect(result.fileDiff.hunks.map(hunk => [hunk.additionStart, hunk.additionCount, hunk.collapsedBefore]))
      .toEqual([[1, 3, 0], [8, 3, 4], [100, 1, 89]])
    const visible = result.fileDiff.hunks.flatMap(hunk => hunk.hunkContent.flatMap(content =>
      content.type === 'context' ? result.fileDiff.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.lines) : []))
    expect(visible).toEqual(['context-0\n', 'context-1\n', 'context-2\n', 'context-7\n', 'context-8\n', 'context-9\n'])
    expect(JSON.stringify(original)).toBe(before)
    expect(original.additionLines).toContain('context-4\n')
    expect(result.fileDiff.additionLines).not.toContain('context-4\n')
    expect(result.fileDiff.additionLines).toHaveLength(7)
  })
  it('keeps unequal replacements and subsequent line-number offsets exact', () => {
    const source = '@@ -4,12 +8,13 @@\n-old one\n-old two\n+new one\n+new two\n+new three\n' + Array.from({ length: 10 }, (_, i) => ` context-${i}\n`).join('')
    const original = parse(source)
    const { fileDiff } = foldCapturedContext(original)
    expect(fileDiff.hunks[0]).toMatchObject({ deletionStart: 4, additionStart: 8, deletionCount: 5, additionCount: 6, deletionLines: 2, additionLines: 3 })
    expect(fileDiff.hunks[1]).toMatchObject({ deletionStart: 13, additionStart: 18, deletionCount: 3, additionCount: 3, deletionLineIndex: 5, additionLineIndex: 6, splitLineStart: original.hunks[0].splitLineStart + 10, unifiedLineStart: original.hunks[0].unifiedLineStart + 12 })
  })
  it('preserves no-final-newline evidence only on the final displayed section', () => {
    const original = parse('@@ -1,10 +1,10 @@\n' + Array.from({ length: 10 }, (_, i) => ` context-${i}\n`).join('') + '\\ No newline at end of file\n')
    const { fileDiff } = foldCapturedContext(original)
    expect(fileDiff.hunks[0]).toMatchObject({ noEOFCRAdditions: false, noEOFCRDeletions: false })
    expect(fileDiff.hunks[1].noEOFCRAdditions).toBe(original.hunks[0].noEOFCRAdditions)
    expect(fileDiff.hunks[1].noEOFCRDeletions).toBe(original.hunks[0].noEOFCRDeletions)
  })
  it('reuses unmodified metadata when there is nothing to fold', () => {
    const original = parse('@@ -0,0 +1,2 @@\n+first\n+second\n')
    expect(foldCapturedContext(original)).toEqual({ fileDiff: original, hidden: 0 })
    expect(foldCapturedContext(original).fileDiff).toBe(original)
  })
})
