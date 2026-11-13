import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

// Pierre treats patch hunks as supplied context, not complete files. Fold only
// that captured context into smaller partial hunks; never claim full-file data
// or install a loader that reads today's workspace to expand historical evidence.
export function foldCapturedContext(file: FileDiffMetadata): { fileDiff: FileDiffMetadata; hidden: number } {
  if (!file.hunks.some(hunk => hunk.hunkContent.some(content => content.type === 'context' && content.lines > 8))) return { fileDiff: file, hidden: 0 }
  const hunks: Hunk[] = []
  const additionLines: string[] = [], deletionLines: string[] = []
  let hidden = 0
  for (const original of file.hunks) {
    let oldLine = original.deletionStart, newLine = original.additionStart
    let oldIndex = original.deletionLineIndex, newIndex = original.additionLineIndex
    let split = original.splitLineStart, unified = original.unifiedLineStart
    let gap = original.collapsedBefore
    let section: Hunk | undefined
    const begin = (): Hunk => section ??= {
      ...original, hunkContent: [], collapsedBefore: gap,
      deletionStart: oldLine, additionStart: newLine,
      deletionLineIndex: deletionLines.length, additionLineIndex: additionLines.length,
      deletionCount: 0, additionCount: 0, deletionLines: 0, additionLines: 0,
      splitLineStart: split, unifiedLineStart: unified, splitLineCount: 0, unifiedLineCount: 0,
      noEOFCRAdditions: false, noEOFCRDeletions: false
    }
    const flush = (): void => {
      if (!section) return
      section.hunkSpecs = `@@ -${section.deletionStart},${section.deletionCount} +${section.additionStart},${section.additionCount} @@\n`
      hunks.push(section)
      section = undefined
      gap = 0
    }
    const context = (lines: number): void => {
      const hunk = begin()
      hunk.hunkContent.push({ type: 'context', lines, additionLineIndex: additionLines.length, deletionLineIndex: deletionLines.length })
      additionLines.push(...file.additionLines.slice(newIndex, newIndex + lines))
      deletionLines.push(...file.deletionLines.slice(oldIndex, oldIndex + lines))
      hunk.additionCount += lines; hunk.deletionCount += lines
      hunk.splitLineCount += lines; hunk.unifiedLineCount += lines
      oldLine += lines; newLine += lines; oldIndex += lines; newIndex += lines
      split += lines; unified += lines
    }
    for (const content of original.hunkContent) {
      if (content.type === 'context') {
        if (content.lines <= 8) context(content.lines)
        else {
          context(3)
          flush()
          const skipped = content.lines - 6
          hidden += skipped
          oldLine += skipped; newLine += skipped; oldIndex += skipped; newIndex += skipped
          split += skipped; unified += skipped
          gap = skipped
          context(3)
        }
      } else {
        const hunk = begin()
        hunk.hunkContent.push({ ...content, additionLineIndex: additionLines.length, deletionLineIndex: deletionLines.length })
        for (let index = 0; index < content.additions; index++) additionLines.push(file.additionLines[newIndex + index])
        for (let index = 0; index < content.deletions; index++) deletionLines.push(file.deletionLines[oldIndex + index])
        hunk.additionCount += content.additions; hunk.deletionCount += content.deletions
        hunk.additionLines += content.additions; hunk.deletionLines += content.deletions
        const splitCount = Math.max(content.additions, content.deletions)
        const unifiedCount = content.additions + content.deletions
        hunk.splitLineCount += splitCount; hunk.unifiedLineCount += unifiedCount
        newLine += content.additions; oldLine += content.deletions
        newIndex += content.additions; oldIndex += content.deletions
        split += splitCount; unified += unifiedCount
      }
    }
    if (section) {
      section.noEOFCRAdditions = original.noEOFCRAdditions
      section.noEOFCRDeletions = original.noEOFCRDeletions
    }
    flush()
  }
  return { fileDiff: { ...file, hunks, additionLines, deletionLines,
    additionCharacterCount: additionLines.reduce((total, line) => total + line.length, 0),
    deletionCharacterCount: deletionLines.reduce((total, line) => total + line.length, 0), cacheKey: undefined }, hidden }
}
