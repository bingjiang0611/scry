import type { DiffFile } from '@shared/trace'

export type DiffLayout = 'unified' | 'split'
export type DiffNotice = 'binary' | 'missing' | 'partial' | 'limit' | 'sourcePartial'
export interface DiffPatchAllocation {
  file: DiffFile
  text?: string
  notices: DiffNotice[]
}

// Virtualization bounds DOM, not parser allocations. Give the selected file priority.
// Larger bodies remain available through recorded-content paging, not today's files.
export const STACK_PATCH_CHARACTER_LIMIT = 1_000_000

export function allocateDiffPatches(files: DiffFile[], selectedPath: string, collapsed: ReadonlySet<string>): DiffPatchAllocation[] {
  let remaining = STACK_PATCH_CHARACTER_LIMIT
  const allocations = new Map<string, DiffPatchAllocation>()
  const selected = files.find(file => file.path === selectedPath)
  for (const file of selected ? [selected, ...files.filter(item => item !== selected)] : files) {
    const notices: DiffNotice[] = []
    if (file.binary) notices.push('binary')
    const complete = file.patchContent?.storage === 'complete' ? file.patchContent.content || file.patch : undefined
    const patch = complete ?? file.patch ?? file.patchContent?.content
    const allocated = file.binary || collapsed.has(file.path) ? 0 : Math.min(patch?.length ?? 0, remaining)
    const limited = Boolean(patch && !file.binary && !collapsed.has(file.path) && patch.length > allocated)
    const length = limited ? Math.max(0, patch!.lastIndexOf('\n', allocated)) : allocated
    remaining -= allocated
    const text = patch?.slice(0, length)
    if (!text && !limited && !file.binary && !collapsed.has(file.path)) notices.push('missing')
    if (file.patchContent?.sourceCompleteness === 'partial') notices.push('sourcePartial')
    if (limited) notices.push('limit')
    else if (complete === undefined && (file.patchStatus === 'truncated' || file.patchContent?.storage === 'truncated')) notices.push('partial')
    allocations.set(file.path, { file, text, notices })
  }
  return files.map(file => allocations.get(file.path)!)
}
