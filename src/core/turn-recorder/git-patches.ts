import {
  snapshotGitArgs,
  TURN_DIFF_PATCH_DEADLINE_MS,
  gitCommand,
  reasonOf
} from './git-command.js'
import {
  type DiffFile,
  type TurnDiffReason,
  type TurnDiffSnapshot,
  type DiffFileChange
} from '../../shared/trace.js'
import {
  type GitTurnDiffCapture
} from './git-capture.js'
import {
  basename,
  relative,
  sep,
  join
} from 'node:path'
import {
  readFile,
  open,
  rm
} from 'node:fs/promises'
import {
  StringDecoder
} from 'node:string_decoder'
import {
  limitToolContent
} from './tool-content.js'

const PATCH_BATCH_MAX_FILES = 128

const PATCH_BATCH_MAX_ARG_BYTES = 64 * 1024

let patchOperationSequence = 0

interface RawPatchRecord {
  path: Buffer
}

interface ParsedPatchBody {
  end: number
  complete: boolean
}

function patchDiffArgs(filterOverrides: string[], command: string[]): string[] {
  return snapshotGitArgs(filterOverrides, [
    '--no-pager',
    '-c', 'core.quotePath=true',
    '-c', 'diff.noprefix=false',
    '-c', 'diff.mnemonicprefix=false',
    '-c', 'diff.suppressBlankEmpty=false',
    '-c', 'color.ui=false',
    '-c', 'color.diff=false',
    ...command
  ])
}

function splitRawPatchOutput(bytes: Buffer): { records: RawPatchRecord[]; patchStart: number } | undefined {
  const records: RawPatchRecord[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (bytes[offset] === 0 && records.length > 0) return { records, patchStart: offset + 1 }
    if (bytes[offset] !== 0x3a) return undefined
    const metadataEnd = bytes.indexOf(0, offset)
    if (metadataEnd < 0) return undefined
    const metadata = bytes.subarray(offset, metadataEnd).toString('ascii')
    if (!/^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/.test(metadata)) return undefined
    const pathStart = metadataEnd + 1
    const pathEnd = bytes.indexOf(0, pathStart)
    if (pathEnd < 0) return undefined
    records.push({ path: bytes.subarray(pathStart, pathEnd) })
    offset = pathEnd + 1
  }
  return records.length === 0 ? { records, patchStart: bytes.length } : undefined
}

function hunkCounts(line: Buffer): { oldLines: number; newLines: number } | undefined {
  const text = line.toString('ascii')
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
  if (!match) return undefined
  const oldLines = Number(match[2] ?? 1)
  const newLines = Number(match[4] ?? 1)
  return Number.isSafeInteger(oldLines) && Number.isSafeInteger(newLines)
    ? { oldLines, newLines }
    : undefined
}

function nextPatchLine(bytes: Buffer, offset: number): { line: Buffer; next: number } | undefined {
  if (offset >= bytes.length) return undefined
  const end = bytes.indexOf(0x0a, offset)
  const next = end < 0 ? bytes.length : end + 1
  return { line: bytes.subarray(offset, end < 0 ? bytes.length : end), next }
}

function parsePatchBody(bytes: Buffer, start: number, allowEof: boolean): ParsedPatchBody | undefined {
  let cursor = start
  const first = nextPatchLine(bytes, cursor)
  if (!first || !first.line.toString('ascii').startsWith('diff --git ')) return undefined
  cursor = first.next
  let sawBodyLine = false
  let oldRemaining = 0
  let newRemaining = 0
  let inHunk = false
  let sawHunk = false
  let sawOldMode = false
  let sawNewMode = false
  let sawFileMode = false
  let sawIndex = false
  let sawOldFile = false
  let sawNewFile = false

  const completeBody = (): boolean => sawHunk || (sawOldMode && sawNewMode) ||
    (sawFileMode && sawIndex) || (sawOldFile && sawNewFile)

  while (cursor < bytes.length) {
    const currentOffset = cursor
    const current = nextPatchLine(bytes, cursor)
    if (!current) break
    cursor = current.next
    const line = current.line
    if (inHunk) {
      if (line.toString('ascii') === '\\ No newline at end of file') continue
      const indicator = line[0]
      if (indicator === 0x20) {
        oldRemaining--
        newRemaining--
      } else if (indicator === 0x2b) {
        newRemaining--
      } else if (indicator === 0x2d) {
        oldRemaining--
      } else {
        return undefined
      }
      if (oldRemaining < 0 || newRemaining < 0) return undefined
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false
      continue
    }

    if (line.toString('ascii').startsWith('diff --git ')) {
      return completeBody() ? { end: currentOffset, complete: true } : undefined
    }
    sawBodyLine = true
    const text = line.toString('ascii')
    sawOldMode ||= text.startsWith('old mode ')
    sawNewMode ||= text.startsWith('new mode ')
    sawFileMode ||= text.startsWith('new file mode ') || text.startsWith('deleted file mode ')
    sawIndex ||= text.startsWith('index ')
    sawOldFile ||= text.startsWith('--- ')
    sawNewFile ||= text.startsWith('+++ ')
    const counts = hunkCounts(line)
    if (counts) {
      oldRemaining = counts.oldLines
      newRemaining = counts.newLines
      inHunk = true
      sawHunk = true
    } else if (text.startsWith('@@ ')) {
      return undefined
    }
  }
  if (inHunk || !sawBodyLine || !completeBody() || !allowEof) return undefined
  return { end: bytes.length, complete: true }
}

function exactGlobPathspec(relPath: string): string {
  let pattern = ''
  for (const character of relPath) {
    pattern += character === '/' ? character : `\\${character}`
  }
  return `:(top,glob)${pattern}`
}

function patchBatchFiles(
  files: DiffFile[],
  capture: GitTurnDiffCapture,
  excludedBasenames: ReadonlySet<string>
): { result: DiffFile[]; pending: Array<{ index: number; file: DiffFile; pathspec: string; pathBytes: Buffer }> } {
  const result = files.map((file) => {
    if (file.binary) return { ...file, patchStatus: 'binary' as const }
    if (file.patchStatus === 'unavailable') return file
    if (excludedBasenames.has(basename(file.path))) {
      return { ...file, patchStatus: 'unavailable' as const, patchReason: 'policy' as const }
    }
    return file
  })
  const pending = files.flatMap((file, index) => {
    if (file.binary || file.patchStatus === 'unavailable' || excludedBasenames.has(basename(file.path))) return []
    const relPath = relative(capture.repoRoot!, file.path).split(sep).join('/')
    return [{ index, file, pathspec: exactGlobPathspec(relPath), pathBytes: Buffer.from(relPath) }]
  })
  return { result, pending }
}

async function readPatchPrefix(path: string, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const bytes = Buffer.alloc(Math.min(size, limit))
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    return { bytes: bytes.subarray(0, offset), truncated: size > offset }
  } finally {
    await file.close()
  }
}

export async function captureTurnPatches(
  capture: GitTurnDiffCapture,
  env: NodeJS.ProcessEnv,
  afterTree: string,
  files: DiffFile[],
  excludedBasenames: ReadonlySet<string>,
  operationDeadline: number,
  completePatches: boolean,
  byteLimit?: number,
  contextLines = 3
): Promise<DiffFile[]> {
  if (!capture.repoRoot || !capture.beforeTree || !capture.tempDir) return files
  const deadline = Math.min(
    completePatches ? operationDeadline : Date.now() + TURN_DIFF_PATCH_DEADLINE_MS,
    byteLimit === undefined ? Infinity : operationDeadline
  )
  let remainingBytes = byteLimit
  const filterOverrides = capture.filterOverrides ?? []
  const { result, pending } = patchBatchFiles(files, capture, excludedBasenames)
  let deadlineReached = false
  const operationId = patchOperationSequence++

  let start = 0
  while (start < pending.length) {
    const batch = pending.slice(start, start + PATCH_BATCH_MAX_FILES)
    const currentBatch: typeof batch = []
    let argBytes = 0
    for (const item of batch) {
      const itemBytes = Buffer.byteLength(item.pathspec) + 1
      if (currentBatch.length > 0 && argBytes + itemBytes > PATCH_BATCH_MAX_ARG_BYTES) break
      currentBatch.push(item)
      argBytes += itemBytes
    }
    if (currentBatch.length === 0) currentBatch.push(batch[0])
    if (remainingBytes === 0) {
      for (const item of currentBatch) result[item.index] = {
        ...item.file, patchStatus: 'unavailable', patchReason: 'budget'
      }
      start += currentBatch.length
      continue
    }
    if (deadlineReached || Date.now() >= deadline) {
      deadlineReached = true
      for (const item of currentBatch) result[item.index] = {
        ...item.file, patchStatus: 'unavailable', patchReason: 'deadline'
      }
      start += currentBatch.length
      continue
    }

    const patchPath = join(capture.tempDir, `patch-operation-${operationId}-batch-${start}.diff`)
    const rawPathspecs = currentBatch.map((item) => item.pathspec)
    let commandError: TurnDiffReason | undefined
    try {
      await gitCommand(
        patchDiffArgs(filterOverrides, [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--raw',
          '-z',
          '--patch',
          `--unified=${contextLines}`,
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--line-prefix=',
          '--output-indicator-new=+',
          '--output-indicator-old=-',
          '--output-indicator-context= ',
          `--output=${patchPath}`,
          capture.beforeTree,
          afterTree,
          '--',
          ...rawPathspecs
        ]),
        { cwd: capture.repoRoot, env, deadline }
      )
    } catch (error) {
      commandError = reasonOf(error)
      if (commandError === 'deadline') deadlineReached = true
    }

    let bytes: Buffer | undefined
    let budgetReached = false
    try {
      if (remainingBytes === undefined) bytes = await readFile(patchPath)
      else {
        const prefix = await readPatchPrefix(patchPath, remainingBytes)
        bytes = prefix.bytes
        remainingBytes -= bytes.length
        budgetReached = prefix.truncated
      }
    } catch {}
    await rm(patchPath, { force: true })
    const parsed = bytes ? splitRawPatchOutput(bytes) : undefined
    let bodyCursor = parsed?.patchStart ?? 0
    const records = parsed?.records ?? []
    const batchByPath = new Map(currentBatch.map((item) => [item.pathBytes.toString('hex'), item]))
    const seenRecordPaths = new Set<string>()
    const rawRecordsMatchBatch = parsed !== undefined && records.length === currentBatch.length && records.every((record) => {
      const key = record.path.toString('hex')
      if (seenRecordPaths.has(key) || !batchByPath.has(key)) return false
      seenRecordPaths.add(key)
      return true
    })
    const capturedIndexes = new Set<number>()
    const recordLimit = commandError || rawRecordsMatchBatch ? records.length : 0
    for (let recordIndex = 0; recordIndex < recordLimit; recordIndex++) {
      const record = records[recordIndex]
      const key = record.path.toString('hex')
      if (seenRecordPaths.size !== records.length && !commandError) break
      const matching = batchByPath.get(key)
      if (!matching || capturedIndexes.has(matching.index)) break
      const body = parsed && bytes ? parsePatchBody(bytes, bodyCursor, !commandError && !budgetReached) : undefined
      if (!body?.complete) break
      result[matching.index] = {
        ...matching.file,
        patch: new StringDecoder('utf8').write(bytes!.subarray(bodyCursor, body.end)),
        patchStatus: 'captured'
      }
      capturedIndexes.add(matching.index)
      bodyCursor = body.end
    }

    for (const item of currentBatch) {
      if (capturedIndexes.has(item.index)) continue
      result[item.index] = {
        ...item.file,
        patchStatus: 'unavailable',
        patchReason: commandError === 'deadline' ? 'deadline' : budgetReached ? 'budget' : 'git_error'
      }
    }
    start += currentBatch.length
  }

  if (deadlineReached) {
    for (const item of pending) {
      if (!result[item.index].patchStatus) result[item.index] = {
        ...item.file, patchStatus: 'unavailable', patchReason: 'deadline'
      }
    }
  }
  return result
}

export function utf8Prefix(value: string, maxBytes: number): { value: string; bytes: number } {
  const buffer = Buffer.from(value)
  const prefix = new StringDecoder('utf8').write(buffer.subarray(0, Math.max(0, maxBytes)))
  return { value: prefix, bytes: Buffer.byteLength(prefix) }
}

export function limitTurnDiffPatchBytes(
  snapshots: TurnDiffSnapshot[],
  maxBytes = Number.POSITIVE_INFINITY
): TurnDiffSnapshot[] {
  let remainingBytes = Math.max(0, maxBytes)
  return snapshots.map((snapshot) => ({
    ...snapshot,
    files: snapshot.files.map((file) => {
      if (!file.patch) return file
      const bytes = Buffer.byteLength(file.patch)
      if (bytes <= remainingBytes) {
        remainingBytes -= bytes
        return file
      }
      const prefix = utf8Prefix(file.patch, remainingBytes)
      remainingBytes -= prefix.bytes
      if (file.patchContent?.contentRef) {
        const patchContent = limitToolContent(file.patchContent, prefix.bytes, 'turn_budget')
        return {
          ...file,
          ...(prefix.value ? { patch: prefix.value } : { patch: undefined }),
          patchContent,
          patchStatus: 'truncated',
          patchReason: undefined
        }
      }
      return prefix.value
        ? { ...file, patch: prefix.value, patchStatus: 'truncated' }
        : { ...file, patch: undefined, patchStatus: 'unavailable', patchReason: 'budget' }
    })
  }))
}

export function parseNameStatus(stdout: string, repoRoot: string): Map<string, DiffFileChange> {
  const fields = stdout.split('\0').filter(Boolean)
  const out = new Map<string, DiffFileChange>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index][0]
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : undefined
    if (change) out.set(join(repoRoot, fields[index + 1]), change)
  }
  return out
}

export function parseNumstat(stdout: string, repoRoot: string): DiffFile[] {
  const out: DiffFile[] = []
  const records = stdout.includes('\0') ? stdout.split('\0') : stdout.split('\n')
  for (const record of records) {
    if (!record.trim()) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const addedRaw = record.slice(0, firstTab)
    const deletedRaw = record.slice(firstTab + 1, secondTab)
    const rel = record.slice(secondTab + 1)
    const binary = addedRaw === '-' || deletedRaw === '-'
    const added = binary ? 0 : Number(addedRaw) || 0
    const deleted = binary ? 0 : Number(deletedRaw) || 0
    out.push({ path: join(repoRoot, rel), added, deleted, ...(binary ? { binary: true } : {}) })
  }
  return out
}

const RAW_RECORD = /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])[0-9]*$/

export function parseRawNumstat(stdout: string, repoRoot: string): DiffFile[] {
  const records = stdout.split('\0')
  const changes = new Map<string, DiffFileChange>()
  let index = 0
  for (; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const match = RAW_RECORD.exec(record)
    if (!match) break
    const rel = records[++index]
    if (!rel) break
    const status = match[1]
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : undefined
    if (change) changes.set(join(repoRoot, rel), change)
  }
  const out = parseNumstat(records.slice(index).join('\0'), repoRoot)
  return out.map((file) => {
    const change = changes.get(file.path)
    return change ? { ...file, change } : file
  })
}
