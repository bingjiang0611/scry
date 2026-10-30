// Bounded, cached reader for Pi native session files (session-manager layout).
//
// Location comes from the catalog-provided session root and the canonical session
// id; records are indexed by line offset so hydrating one turn does not re-parse
// the whole file. Every read re-verifies the file stamp it indexed.

import { createHash, type Hash } from 'node:crypto'
import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { LoadedSessionTurn } from './session-history'
import { historyCopy } from '../shared/constants/copy'
import {
  appendNativeEntry,
  metadataForEntry,
  metadataTurns,
  nativeBranch,
  reconcilePiNativeHistory,
  validateHeader,
  type NativeEntry,
  type NativeEntryLocation
} from './pi-native-parse'

// Session-file reading and the parsing it depends on travel together for the
// history/bootstrap consumers.
export { parsePiNativeHistory, reconcilePiNativeHistory } from './pi-native-parse'

// Offline fallback for catalog-authorized Pi sessions only. No launcher/config
// execution and no renderer-supplied path. Default Pi layout (session-manager).
// Custom profile-owned session roots remain unavailable rather than guessed.
/** The canonical file a catalog-authorized Pi session names, if it exists. */
export async function locatePiNativeSession(args: {
  sessionRoot: string
  cwd: string
  sessionId: string
  signal?: AbortSignal
  maxBytes?: number
}): Promise<{ canonical: string; size: number; revision: string } | null> {
  if (!/^[a-f0-9-]{36}$/i.test(args.sessionId)) return null
  const directory = join(args.sessionRoot, `--${resolve(args.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  let names: string[]
  try { names = await readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const matches = names.filter((name) => name.endsWith(`_${args.sessionId}.jsonl`))
  if (!matches.length) return null
  if (matches.length !== 1) throw new Error('Pi 原生会话文件身份不唯一')
  const path = join(directory, matches[0])
  const root = await realpath(args.sessionRoot)
  const canonical = await realpath(path)
  const inside = relative(root, canonical)
  const info = await lstat(path)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || resolve(root, inside) !== canonical || !info.isFile() || info.isSymbolicLink()) {
    throw new Error('Pi 原生会话路径越界或不是普通文件')
  }
  if (args.maxBytes != null && info.size > args.maxBytes) throw new Error('Pi metering aggregate byte budget reached')
  return { canonical, size: info.size, revision: [canonical, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') }
}

// Version/watch checks inspect the source identity, not its complete message tree.
export async function readPiNativeHistoryRevision(args: Parameters<typeof locatePiNativeSession>[0]): Promise<string | null> {
  return (await locatePiNativeSession(args))?.revision ?? null
}

// Desktop and phone share the same recovery authority. The live registry owns
// in-flight native tails; an unreadable native file cannot hide intact archives.
export async function readPiDisplayHistory(
  args: Parameters<typeof locatePiNativeSession>[0] & { active: boolean },
  readArchive?: () => Promise<LoadedSessionTurn[]>
): Promise<{ turns: LoadedSessionTurn[] | null; error?: Error }> {
  if (args.active) return { turns: null }
  let native: LoadedSessionTurn[] | null
  try { native = await readPiNativeHistory(args) }
  catch (error) {
    args.signal?.throwIfAborted()
    if (!readArchive) throw error
    return { turns: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
  if (!native) return { turns: null }
  return { turns: readArchive ? reconcilePiNativeHistory(native, await readArchive()) : native }
}

// Metering still consumes a whole string and retains its independent byte budget.
export async function readPiNativeSession(args: Parameters<typeof locatePiNativeSession>[0]): Promise<string | null> {
  const source = await locatePiNativeSession(args)
  if (!source) return null
  if (source.size > 64 * 1024 * 1024) throw new Error('Pi metering aggregate byte budget reached')
  return readFile(source.canonical, { encoding: 'utf8', signal: args.signal })
}

interface NativeFileStamp {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface NativeHistoryCache {
  canonical: string
  identity: string
  stamp: NativeFileStamp
  contentHash: string
  endsWithNewline: boolean
  entries: Map<string, NativeEntryLocation>
  leaf?: NativeEntryLocation
}

export class PiNativeHistoryStaleError extends Error {
  constructor() {
    super(historyCopy.nativeSnapshotChanged)
    this.name = 'PiNativeHistoryStaleError'
  }
}

export function isPiNativeHistoryStaleError(error: unknown): boolean {
  return error instanceof PiNativeHistoryStaleError
}

export interface PiNativeHistorySnapshot {
  /** Metadata-only turns. Their items contain identity markers, not provider payload. */
  turns: LoadedSessionTurn[]
  sourceRevision: string
  hydrate(runIds: readonly string[], signal?: AbortSignal): Promise<LoadedSessionTurn[]>
}

const nativeHistoryCaches = new Map<string, NativeHistoryCache>()
const maxNativeHistoryCaches = 4

// Keep only entry locations during the scan, not abandoned branches or image
// payloads. These bounds cap a single record and the tree index, not file size.
// Larger individual records/trees need a paged on-disk index rather than a
// larger whole-file allocation. Returned message text still scales with history.
const maxNativeEntryBytes = 64 * 1024 * 1024
const maxNativeEntries = 1_000_000

async function* nativeLines(
  file: FileHandle,
  size: number,
  signal?: AbortSignal,
  start = 0,
  fullHash?: Hash
): AsyncGenerator<{ line: Buffer; offset: number }> {
  let parts: Buffer[] = []
  let length = 0
  let offset = start
  let position = start
  while (position < size) {
    signal?.throwIfAborted()
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) throw new PiNativeHistoryStaleError()
    position += bytesRead
    const buffer = chunk.subarray(0, bytesRead)
    fullHash?.update(buffer)
    let lineStart = 0
    while (lineStart < buffer.length) {
      const newline = buffer.indexOf(10, lineStart)
      const end = newline === -1 ? buffer.length : newline + 1
      const part = buffer.subarray(lineStart, end)
      length += part.length
      if (length > maxNativeEntryBytes) throw new Error('Pi 原生会话单条记录超过 64 MiB')
      parts.push(part)
      if (newline !== -1) {
        yield { line: Buffer.concat(parts, length), offset }
        offset += length
        parts = []
        length = 0
      }
      lineStart = end
    }
  }
  if (length) yield { line: Buffer.concat(parts, length), offset }
}

function nativeStamp(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): NativeFileStamp {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

function sameNativeStamp(left: NativeFileStamp, right: NativeFileStamp): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function assertNativeSourceStable(file: FileHandle, canonical: string, expected: NativeFileStamp): Promise<NativeFileStamp> {
  const [handleStat, pathStat] = await Promise.all([file.stat(), lstat(canonical)])
  const actual = nativeStamp(handleStat)
  if (!handleStat.isFile() || handleStat.isSymbolicLink() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
      !sameNativeStamp(actual, expected) || !sameNativeStamp(nativeStamp(pathStat), expected)) throw new PiNativeHistoryStaleError()
  return actual
}

async function hashNativeFile(file: FileHandle, size: number, prefixSize: number, signal?: AbortSignal): Promise<{ contentHash: string; prefixHash: string }> {
  const content = createHash('sha256')
  const prefix = createHash('sha256')
  let position = 0
  while (position < size) {
    signal?.throwIfAborted()
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
    if (!bytesRead) throw new PiNativeHistoryStaleError()
    const bytes = chunk.subarray(0, bytesRead)
    content.update(bytes)
    if (position < prefixSize) prefix.update(bytes.subarray(0, Math.min(bytes.length, prefixSize - position)))
    position += bytesRead
  }
  return { contentHash: content.digest('hex'), prefixHash: prefix.digest('hex') }
}

function cacheNativeHistory(cache: NativeHistoryCache): void {
  nativeHistoryCaches.delete(cache.canonical)
  nativeHistoryCaches.set(cache.canonical, cache)
  while (nativeHistoryCaches.size > maxNativeHistoryCaches) nativeHistoryCaches.delete(nativeHistoryCaches.keys().next().value!)
}

async function readNativeSnapshot(args: Parameters<typeof readPiNativeSession>[0]): Promise<PiNativeHistorySnapshot | null> {
  args.signal?.throwIfAborted()
  const source = await locatePiNativeSession(args)
  if (!source) return null
  const file = await open(source.canonical, 'r')
  try {
    const before = nativeStamp(await file.stat())
    const pathBefore = nativeStamp(await lstat(source.canonical))
    if (!sameNativeStamp(before, pathBefore) || before.size !== source.size) throw new PiNativeHistoryStaleError()
    const identity = `${args.sessionId}\\0${args.cwd}`
    const cached = nativeHistoryCaches.get(source.canonical)
    let entries: Map<string, NativeEntryLocation> = new Map()
    let leaf: NativeEntryLocation | undefined
    let contentHash = ''
    let endsWithNewline = false
    const unchanged = cached && cached.identity === identity && sameNativeStamp(cached.stamp, before)
    if (unchanged) {
      entries = new Map(cached.entries)
      leaf = cached.leaf
      contentHash = cached.contentHash
      endsWithNewline = cached.endsWithNewline
    } else if (cached && cached.identity === identity && cached.stamp.dev === before.dev && cached.stamp.ino === before.ino &&
      before.size > cached.stamp.size && cached.endsWithNewline) {
      // Size/inode alone do not prove append. Hash the complete current file and
      // compare the old prefix before parsing only the newly appended records.
      const hashes = await hashNativeFile(file, before.size, cached.stamp.size, args.signal)
      if (hashes.prefixHash === cached.contentHash) {
        entries = new Map(cached.entries)
        leaf = cached.leaf
        for await (const { line, offset } of nativeLines(file, before.size, args.signal, cached.stamp.size)) {
          const text = line.toString('utf8')
          if (!text.trim()) continue
          const entry = JSON.parse(text) as NativeEntry
          if (typeof entry.id !== 'string' || entries.has(entry.id)) throw new Error(historyCopy.nativeEntryInvalid)
          if (entries.size >= maxNativeEntries) throw new Error(historyCopy.nativeRecordLimit)
          const location = { id: entry.id, parentId: entry.parentId, offset, length: line.length, metadata: metadataForEntry(entry) }
          entries.set(entry.id, location)
          leaf = location
        }
        contentHash = hashes.contentHash
        endsWithNewline = before.size > 0 && (await readNativeByte(file, before.size - 1)) === 10
      }
    }
    if (!contentHash) {
      let hasHeader = false
      const hash = createHash('sha256')
      for await (const { line, offset } of nativeLines(file, before.size, args.signal, 0, hash)) {
        args.signal?.throwIfAborted()
        const text = line.toString('utf8')
        if (!text.trim()) continue
        const entry = JSON.parse(text) as NativeEntry
        if (!hasHeader) {
          validateHeader(entry, args)
          hasHeader = true
          continue
        }
        if (typeof entry.id !== 'string' || entries.has(entry.id)) throw new Error(historyCopy.nativeEntryInvalid)
        if (entries.size >= maxNativeEntries) throw new Error(historyCopy.nativeRecordLimit)
        const location = { id: entry.id, parentId: entry.parentId, offset, length: line.length, metadata: metadataForEntry(entry) }
        entries.set(entry.id, location)
        leaf = location
      }
      if (!hasHeader) validateHeader(undefined, args)
      contentHash = hash.digest('hex')
      endsWithNewline = before.size > 0 && (await readNativeByte(file, before.size - 1)) === 10
    }
    const after = await assertNativeSourceStable(file, source.canonical, before)
    if (!sameNativeStamp(after, before)) throw new PiNativeHistoryStaleError()
    const next: NativeHistoryCache = { canonical: source.canonical, identity, stamp: before, contentHash, endsWithNewline, entries, leaf }
    cacheNativeHistory(next)
    const branch = nativeBranch(entries, leaf)
    const turns = metadataTurns(entries, leaf)
    const locationsByRunId = new Map<string, NativeEntryLocation[]>()
    let turnIndex = -1
    for (const entry of branch) {
      if (entry.metadata.role === 'user') turnIndex += 1
      if (turnIndex < 0) continue
      const turn = turns[turnIndex]
      const locations = locationsByRunId.get(turn.runId!)
      if (locations) locations.push(entry)
      else locationsByRunId.set(turn.runId!, [entry])
    }
    const sourceRevision = `${source.canonical}:${before.size}:${contentHash}`
    const hydrate = async (runIds: readonly string[], signal?: AbortSignal): Promise<LoadedSessionTurn[]> => {
      signal?.throwIfAborted()
      const current = await open(source.canonical, 'r')
      try {
        await assertNativeSourceStable(current, source.canonical, before)
        const hydrated: LoadedSessionTurn[] = []
        for (const runId of runIds) {
          const locations = locationsByRunId.get(runId)
          if (!locations) continue
          const turn: LoadedSessionTurn[] = []
          for (const location of locations) {
            signal?.throwIfAborted()
            if (location.offset < 0 || location.length <= 0 || location.offset + location.length > before.size) throw new PiNativeHistoryStaleError()
            const buffer = Buffer.allocUnsafe(location.length)
            let read = 0
            while (read < buffer.length) {
              const result = await current.read(buffer, read, buffer.length - read, location.offset + read)
              if (!result.bytesRead) throw new PiNativeHistoryStaleError()
              read += result.bytesRead
            }
            const entry = JSON.parse(buffer.toString('utf8')) as NativeEntry
            if (entry.id !== location.id || Buffer.byteLength(buffer.toString('utf8')) !== location.length) throw new PiNativeHistoryStaleError()
            appendNativeEntry(turn, entry)
          }
          if (turn[0]) hydrated.push(turn[0])
        }
        await assertNativeSourceStable(current, source.canonical, before)
        return hydrated
      } finally { await current.close() }
    }
    return { turns, sourceRevision, hydrate }
  } finally {
    await file.close()
  }
}

async function readNativeByte(file: FileHandle, position: number): Promise<number> {
  const buffer = Buffer.alloc(1)
  const result = await file.read(buffer, 0, 1, position)
  if (result.bytesRead !== 1) throw new PiNativeHistoryStaleError()
  return buffer[0]
}

export async function readPiNativeHistorySnapshot(args: Parameters<typeof readPiNativeSession>[0]): Promise<PiNativeHistorySnapshot | null> {
  return readNativeSnapshot(args)
}

export async function readPiNativeHistory(args: Parameters<typeof readPiNativeSession>[0]): Promise<LoadedSessionTurn[] | null> {
  const snapshot = await readNativeSnapshot(args)
  if (!snapshot) return null
  return snapshot.hydrate(snapshot.turns.map((turn) => turn.runId!), args.signal)
}
