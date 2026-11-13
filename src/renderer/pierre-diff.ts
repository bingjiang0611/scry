import { parsePatchFiles, type CodeViewItem, type FileDiffMetadata } from '@pierre/diffs'
import { DIFF_COPY as copy } from './constants/diff-copy'

export type ParsedDiffBody =
  | { kind: 'diff'; fileDiff: FileDiffMetadata }
  | { kind: 'raw'; text: string; error: string }

export function parseDiffBody(text: string, path: string): ParsedDiffBody {
  // GitHub and some providers supply only hunks. Supply file identity, never file contents.
  const patch = text.startsWith('@@ ')
    ? `--- ${JSON.stringify(`a/${path}`)}\n+++ ${JSON.stringify(`b/${path}`)}\n${text}`
    : text
  try {
    const files = parsePatchFiles(patch, { throwOnError: true, disableLineMatching: true }).flatMap(entry => entry.files)
    if (files.length !== 1) return { kind: 'raw', text, error: copy.singleFilePatch }
    return { kind: 'diff', fileDiff: files[0] }
  } catch (error) {
    // Truncated/malformed evidence is still inspectable, but is not a valid line-comment target.
    return { kind: 'raw', text, error: error instanceof Error ? error.message : String(error) }
  }
}

// CodeView retains the previous payload when an item's version is unchanged.
// Reuse a revision only for the same immutable body; weak keys don't retain old evidence.
let nextVersion = 0
const versions = new WeakMap<ParsedDiffBody, number>()

export function diffBodyItem(id: string, body: ParsedDiffBody): CodeViewItem<undefined> {
  let version = versions.get(body)
  if (version === undefined) {
    version = ++nextVersion
    versions.set(body, version)
  }
  return body.kind === 'diff'
    ? { id, type: 'diff', version, fileDiff: body.fileDiff }
    : { id, type: 'file', version, file: { name: id, contents: body.text, lang: 'diff' } }
}

export function emptyDiffItem(id: string): CodeViewItem<undefined> {
  // Header-only unavailable/binary evidence. No synthetic file body or current-file hydration.
  return {
    id, type: 'diff', version: 0, collapsed: true,
    fileDiff: {
      name: id, type: 'change', isPartial: true, hunks: [],
      splitLineCount: 0, unifiedLineCount: 0,
      deletionLines: [], additionLines: [], deletionCharacterCount: 0, additionCharacterCount: 0
    }
  }
}
