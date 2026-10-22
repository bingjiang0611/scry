import { createHash, type Hash } from 'node:crypto'
import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { LoadedSessionTurn } from './session-history'
import { classifyTool, type TraceEvent } from '../shared/trace'
import { historyCopy } from '../shared/constants/copy'

interface NativeEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  cwd?: string
  version?: number
  message?: {
    role: string
    content?: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>
    toolCallId?: string
    toolName?: string
    isError?: boolean
  }
}

const recoveryNotice = '来自 Pi 原生会话记录；Scry 运行归档缺失，终态、审批、用量与文件变更未核对。'

// Native entry IDs describe the session tree, not Scry run IDs. Walk the current
// leaf ancestry so abandoned branches do not leak into the displayed timeline.
export function parsePiNativeHistory(content: string, identity: { sessionId: string; cwd: string }): LoadedSessionTurn[] {
  const entries = content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as NativeEntry)
  validateHeader(entries.shift(), identity)
  const byId = new Map<string, NativeEntry>()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || byId.has(entry.id)) throw new Error(historyCopy.nativeEntryInvalid)
    byId.set(entry.id, entry)
  }
  const turns: LoadedSessionTurn[] = []
  for (const entry of nativeBranch(byId, entries.at(-1))) appendNativeEntry(turns, entry)
  return turns
}

function validateHeader(header: NativeEntry | undefined, identity: { sessionId: string; cwd: string }): void {
  if (header?.type !== 'session' || header.version !== 3 || header.id !== identity.sessionId ||
      header.cwd !== identity.cwd) throw new Error('Pi 原生会话身份或格式不匹配')
}

function nativeBranch<T extends Pick<NativeEntry, 'id' | 'parentId'>>(byId: Map<string, T>, leaf: T | undefined): T[] {
  const chain: T[] = []
  const visited = new Set<string>()
  let entry = leaf
  while (entry) {
    if (visited.has(entry.id!)) throw new Error('Pi 原生会话分支存在循环')
    visited.add(entry.id!)
    chain.push(entry)
    if (entry.parentId === null) break
    if (typeof entry.parentId !== 'string' || !byId.has(entry.parentId)) throw new Error('Pi 原生会话分支不完整')
    entry = byId.get(entry.parentId)
  }
  return chain.reverse()
}

function appendNativeEntry(turns: LoadedSessionTurn[], current: NativeEntry): void {
  let turn = turns.at(-1)
  if (current.type !== 'message' || !current.message) return
  const message = current.message
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
  if (message.role === 'user') {
    turn = { runId: `pi-native-${current.id}`, userText: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
      items: [], errorHint: recoveryNotice }
    if (blocks.some((block) => block.type === 'image')) turn.errorHint += ' 原始图片未恢复。'
    turns.push(turn)
    return
  }
  if (!turn) return
  if (typeof current.timestamp !== 'string' || !Number.isFinite(Date.parse(current.timestamp))) {
    throw new Error('Pi 原生消息时间无效')
  }
  const emit = (index: number, fields: Pick<TraceEvent, 'kind' | 'stage'> & Partial<TraceEvent>): void => {
    turn!.items.push({ id: `pi-native-${current.id}-${index}`, runId: turn!.runId!, ts: current.timestamp!,
      providerId: 'pi', runtimeProvider: 'pi_rpc', runtimeMetadata: { source: 'pi_native_transcript' }, ...fields })
  }
  if (message.role === 'assistant') {
    blocks.forEach((block, index) => {
      if (block.type === 'text' && typeof block.text === 'string') emit(index, { kind: 'model', stage: 'text', text: block.text, messageId: current.id })
      else if (block.type === 'thinking' && typeof block.thinking === 'string') emit(index, { kind: 'model', stage: 'thinking', thinking: block.thinking, messageId: current.id })
      else if (block.type === 'toolCall' && block.id && block.name) {
        const name = block.name === 'subagent' ? 'Agent' : block.name
        const classified = classifyTool(name, block.arguments)
        emit(index, { kind: classified.kind, stage: `${classified.kind}:${classified.name}`,
          name: classified.name, toolUseId: block.id, tool: name, input: block.arguments })
      }
    })
  } else if (message.role === 'toolResult' && message.toolCallId) {
    emit(0, { kind: 'tool', stage: 'tool_result', toolUseId: message.toolCallId, tool: message.toolName,
      output: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'), isError: message.isError })
  }
}

// Pi's adapter uses the initial native user entry ID as providerTurnId. A steer
// creates another native user entry inside that same run. Match those segments
// through the anchored run's exact tool lifecycle IDs; equal prompts alone
// never establish ownership.
export function reconcilePiNativeHistory(native: LoadedSessionTurn[], archived: LoadedSessionTurn[]): LoadedSessionTurn[] {
  const byRunId = new Map(native.map((turn) => [turn.runId, [turn]]))
  const toolKey = (event: TraceEvent): string => `${event.stage === 'tool_result' ? 'result' : 'call'}:${event.toolUseId}`
  const toolOwners = new Map<string, LoadedSessionTurn | null>()
  for (const turn of archived) {
    for (const event of turn.items) {
      if (!event.toolUseId) continue
      const key = toolKey(event)
      const owner = toolOwners.get(key)
      toolOwners.set(key, owner === undefined || owner === turn ? turn : null)
    }
  }
  let unlinked: LoadedSessionTurn[] = []
  for (const turn of archived) {
    const key = turn.providerTurnId ? `pi-native-${turn.providerTurnId}` : undefined
    if (key && byRunId.has(key)) {
      // Archive order proves these attempts precede this exact native boundary.
      // Appending every unlinked attempt at the end makes old interruptions look
      // like the latest turn. Ordering is not identity: keep each attempt intact.
      byRunId.set(key, [...unlinked, turn])
      unlinked = []
    } else unlinked.push({ ...turn, errorHint: [turn.errorHint,
      '此归档缺少可对应的原生回合标识，单独保留；可能与恢复记录重叠，不能据提示词去重。'].filter(Boolean).join(' ') })
  }
  let anchor: LoadedSessionTurn | undefined
  const remainingSteers = new Map<string, number>()
  const reconciled = native.flatMap((turn) => {
    const replacements = byRunId.get(turn.runId)!
    const canonical = replacements.at(-1)!
    if (canonical !== turn) {
      anchor = canonical
      remainingSteers.clear()
      const seenSteers = new Set<string>()
      for (const event of canonical.items) {
        const steer = event.steer
        if (event.stage !== 'steer' || steer?.status !== 'accepted' || seenSteers.has(steer.messageId)) continue
        seenSteers.add(steer.messageId)
        remainingSteers.set(steer.prompt, (remainingSteers.get(steer.prompt) ?? 0) + 1)
      }
      return replacements
    }
    // A settled, successful run owns its complete response. Interrupted/partial
    // archives must not swallow a native tail that outlived Scry's capture.
    if (!anchor?.done || !anchor.items.some((event) => event.stage === 'result' && event.isError === false)) return [turn]
    const tools = turn.items.filter((event) => event.toolUseId)
    // Require an invocation plus every observed call/result in this segment.
    // Text-only steers remain unlinked until native steer entry IDs are archived;
    // neither equal prompts nor timestamps establish ownership.
    const covered = tools.some((event) => event.stage !== 'tool_result') &&
      tools.every((event) => toolOwners.get(toolKey(event)) === anchor)
    if (!covered) return [turn]
    // Identity is already proven by tools. Also require the native input to be
    // present in the archive, without reusing one receipt for repeated prompts.
    const inputs = remainingSteers.get(turn.userText) ?? 0
    if (inputs === 0) return [turn]
    remainingSteers.set(turn.userText, inputs - 1)
    return []
  })
  return [...reconciled, ...unlinked]
}

// Offline fallback for catalog-authorized Pi sessions only. No launcher/config
// execution and no renderer-supplied path. Default Pi layout (session-manager).
// Custom profile-owned session roots remain unavailable rather than guessed.
async function locatePiNativeSession(args: {
  sessionRoot: string
  cwd: string
  sessionId: string
  signal?: AbortSignal
  maxBytes?: number
}): Promise<{ canonical: string; size: number } | null> {
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
  return { canonical, size: info.size }
}

// Metering still consumes a whole string and retains its independent byte budget.
export async function readPiNativeSession(args: Parameters<typeof locatePiNativeSession>[0]): Promise<string | null> {
  const source = await locatePiNativeSession(args)
  if (!source) return null
  if (source.size > 64 * 1024 * 1024) throw new Error('Pi metering aggregate byte budget reached')
  return readFile(source.canonical, { encoding: 'utf8', signal: args.signal })
}

interface NativeEntryMetadata extends Pick<NativeEntry, 'id' | 'parentId' | 'type' | 'timestamp'> {
  role?: string
  userText?: string
  blocks?: Array<{ type: string; id?: string; name?: string }>
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

interface NativeEntryLocation extends Pick<NativeEntry, 'id' | 'parentId'> {
  offset: number
  length: number
  metadata: NativeEntryMetadata
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

function metadataForEntry(entry: NativeEntry): NativeEntryMetadata {
  const message = entry.message
  const blocks = message?.content && typeof message.content !== 'string'
    ? message.content
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({ type: block.type, id: block.id, name: block.name }))
    : undefined
  const userText = message?.role === 'user'
    ? (typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'))
    : undefined
  return {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    role: message?.role,
    userText,
    blocks,
    toolCallId: message?.toolCallId,
    toolName: message?.toolName,
    isError: message?.isError
  }
}

function appendNativeMetadata(turns: LoadedSessionTurn[], current: NativeEntryMetadata): void {
  if (current.type !== 'message' || !current.role) return
  if (current.role === 'user') {
    turns.push({ runId: `pi-native-${current.id}`, userText: current.userText ?? '', items: [], errorHint: recoveryNotice })
    return
  }
  const turn = turns.at(-1)
  if (!turn) return
  const emit = (stage: TraceEvent['stage'], toolUseId?: string): void => {
    turn.items.push({ id: `pi-native-${current.id}`, runId: turn.runId!, ts: current.timestamp ?? '', kind: stage === 'tool_result' ? 'tool' : 'tool', stage,
      toolUseId, runtimeMetadata: { source: 'pi_native_transcript' } })
  }
  if (current.role === 'assistant') {
    for (const block of current.blocks ?? []) if (block.type === 'toolCall' && block.id) emit('tool_call', block.id)
  } else if (current.role === 'toolResult' && current.toolCallId) emit('tool_result', current.toolCallId)
}

function metadataTurns(entries: Map<string, NativeEntryLocation>, leaf: NativeEntryLocation | undefined): LoadedSessionTurn[] {
  const turns: LoadedSessionTurn[] = []
  for (const location of nativeBranch(entries, leaf)) appendNativeMetadata(turns, location.metadata)
  return turns
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
