import { isAbsolute, relative, sep } from 'node:path'
import type { TurnDiffExcludeEvidence } from '../../shared/turn-diff.js'
import type { DiffFile } from '../../shared/trace.js'

export const UNTRACKED_PATCH_FILE_LIMIT = 50

export interface TurnDiffFilePolicyResult {
  files: DiffFile[]
  excluded: TurnDiffExcludeEvidence
}

interface ExclusionPrefix {
  declared: string
  prefix: string
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

function exclusionPrefixes(repoRoot: string, entries: string[]): ExclusionPrefix[] {
  const prefixes: ExclusionPrefix[] = []
  for (const declared of entries) {
    if (!isAbsolute(declared)) {
      const normalized = declared.replace(/^\.\//, '').replace(/\/+$/, '')
      if (normalized) prefixes.push({ declared, prefix: normalized })
      continue
    }
    const rel = relative(repoRoot, declared).split(sep).join('/')
    if (rel === '..' || rel.startsWith('../')) continue
    prefixes.push({ declared, prefix: rel.replace(/\/+$/, '') })
  }
  return prefixes
}

function matchesExclusion(relPath: string, prefix: string): boolean {
  if (!prefix) return true
  return relPath === prefix || relPath.startsWith(`${prefix}/`)
}

export function applyTurnDiffFilePolicy(args: {
  files: DiffFile[]
  repoRoot: string
  diffExclude: string[]
  untracked: Set<string> | undefined
  untrackedLimit?: number
}): TurnDiffFilePolicyResult {
  const prefixes = exclusionPrefixes(args.repoRoot, args.diffExclude)
  const kept: DiffFile[] = []
  const declared = new Set<string>()
  let excludedFiles = 0
  for (const file of args.files) {
    if (prefixes.length === 0) {
      kept.push(file)
      continue
    }
    const rel = repoRelative(args.repoRoot, file.path)
    const matched = prefixes.filter((entry) => matchesExclusion(rel, entry.prefix))
    if (matched.length === 0) {
      kept.push(file)
      continue
    }
    excludedFiles += 1
    for (const entry of matched) declared.add(entry.declared)
  }
  const files = kept
  const excluded: TurnDiffExcludeEvidence = { paths: [...declared].sort(), files: excludedFiles }
  if (!args.untracked?.size) return { files, excluded }
  const limit = args.untrackedLimit ?? UNTRACKED_PATCH_FILE_LIMIT
  const newUntracked = files.filter((file) =>
    file.change === 'added' && args.untracked!.has(file.path))
  if (newUntracked.length <= limit) return { files, excluded }
  const omitted = new Set(newUntracked.map((file) => file.path))
  return {
    excluded,
    files: files.map((file) => omitted.has(file.path)
      ? { ...file, patchStatus: 'unavailable' as const, patchReason: 'policy' as const }
      : file)
  }
}
