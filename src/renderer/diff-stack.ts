import type { DiffFile } from '@shared/trace'
import { parseUnifiedDiff, type DiffLine } from './diff-lines'

export type DiffLayout = 'unified' | 'split'
export type CodeRow =
  | { kind: 'line'; line: DiffLine }
  | { kind: 'pair'; left?: DiffLine; right?: DiffLine }
  | { kind: 'context'; id: number; count: number }
export type StackRow =
  | { kind: 'file'; file: DiffFile }
  | { kind: 'notice'; file: DiffFile; reason: 'binary' | 'missing' | 'partial' | 'limit' | 'sourcePartial' }
  | { kind: 'code'; file: DiffFile; row: CodeRow }

// DOM is virtualized separately. Bound parser allocations too; selecting a file gives its
// supplied patch priority. Beyond this budget, use recorded-content paging rather than
// increasing the limit or reconstructing historical context from today's filesystem.
export const STACK_PATCH_CHARACTER_LIMIT = 1_000_000
export const DIFF_ROW_HEIGHT = 24

export function codeRows(patch: string, layout: DiffLayout, expanded: ReadonlySet<number>): CodeRow[] {
  const lines = parseUnifiedDiff(patch)
  const result: CodeRow[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line.kind === 'meta' && (!line.text || /^(?:diff --git |index |--- |\+\+\+ )/.test(line.text))) { index++; continue }
    if (line.kind === 'context') {
      let end = index + 1
      while (end < lines.length && lines[end].kind === 'context') end++
      if (end - index > 8 && !expanded.has(index) && !expanded.has(-1)) {
        for (const entry of lines.slice(index, index + 3)) result.push({ kind: 'line', line: entry })
        result.push({ kind: 'context', id: index, count: end - index - 6 })
        for (const entry of lines.slice(end - 3, end)) result.push({ kind: 'line', line: entry })
      } else for (let cursor = index; cursor < end; cursor++) result.push({ kind: 'line', line: lines[cursor] })
      index = end
    } else if (layout === 'split' && (line.kind === 'add' || line.kind === 'del')) {
      const left: DiffLine[] = [], right: DiffLine[] = []
      while (index < lines.length && lines[index].kind === 'del') left.push(lines[index++])
      while (index < lines.length && lines[index].kind === 'add') right.push(lines[index++])
      for (let cursor = 0; cursor < Math.max(left.length, right.length); cursor++) {
        result.push({ kind: 'pair', left: left[cursor], right: right[cursor] })
      }
    } else { result.push({ kind: 'line', line }); index++ }
  }
  return result
}

export function buildDiffStack(files: DiffFile[], layout: DiffLayout, collapsed: ReadonlySet<string>,
  expanded: ReadonlyMap<string, ReadonlySet<number>>, selectedPath: string): { rows: StackRow[]; starts: Map<string, number>; columns: number } {
  let remaining = STACK_PATCH_CHARACTER_LIMIT
  const patches = new Map<string, { text?: string; limited: boolean; partial: boolean }>()
  const priority = files.find(file => file.path === selectedPath)
  for (const file of priority ? [priority, ...files.filter(item => item !== priority)] : files) {
    if (collapsed.has(file.path)) continue
    // Complete storage may be a reference-only envelope; its empty preview is not the body.
    const complete = file.patchContent?.storage === 'complete' ? file.patchContent.content || file.patch : undefined
    const patch = complete ?? file.patch ?? file.patchContent?.content
    const allocated = Math.min(patch?.length ?? 0, remaining)
    const limited = Boolean(patch && patch.length > allocated)
    const length = limited ? Math.max(0, patch!.lastIndexOf('\n', allocated)) : allocated
    const text = patch?.slice(0, length)
    // Charge scanned characters too: repeated long lines must not each rescan the full budget.
    remaining -= allocated
    patches.set(file.path, { text, limited, partial: complete === undefined && (file.patchStatus === 'truncated' || file.patchContent?.storage === 'truncated') })
  }
  const rows: StackRow[] = [], starts = new Map<string, number>()
  for (const file of files) {
    starts.set(file.path, rows.length)
    rows.push({ kind: 'file', file })
    if (collapsed.has(file.path)) continue
    const patch = patches.get(file.path)!
    if (file.binary) rows.push({ kind: 'notice', file, reason: 'binary' })
    else if (patch.text) {
      for (const row of codeRows(patch.text, layout, expanded.get(file.path) ?? new Set())) rows.push({ kind: 'code', file, row })
    } else if (!patch.limited) rows.push({ kind: 'notice', file, reason: 'missing' })
    if (file.patchContent?.sourceCompleteness === 'partial') rows.push({ kind: 'notice', file, reason: 'sourcePartial' })
    if (patch.limited || patch.partial) rows.push({ kind: 'notice', file, reason: patch.limited ? 'limit' : 'partial' })
  }
  let columns = 0
  for (const entry of rows) {
    if (entry.kind !== 'code' || entry.row.kind === 'context') continue
    const lines = entry.row.kind === 'line' ? [entry.row.line] : [entry.row.left, entry.row.right]
    for (const line of lines) {
      if (!line) continue
      let width = line.text.length
      // Reserve two monospace cells for tabs/non-ASCII glyphs. This also avoids per-line
      // horizontal scrollbars: both split columns share the outer patch scroll container.
      for (let index = 0; index < line.text.length; index++) if (line.text[index] === '\t' || line.text.charCodeAt(index) > 127) width++
      columns = Math.max(columns, width)
    }
  }
  return { rows, starts, columns }
}
