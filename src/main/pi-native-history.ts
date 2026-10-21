import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { LoadedSessionTurn } from './session-history'
import { classifyTool, type TraceEvent } from '../shared/trace'

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
    if (typeof entry.id !== 'string' || byId.has(entry.id)) throw new Error('Pi 原生会话 entry id 无效')
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

interface NativeEntryLocation extends Pick<NativeEntry, 'id' | 'parentId'> {
  offset: number
  length: number
}

// Keep only entry locations during the scan, not abandoned branches or image
// payloads. These bounds cap a single record and the tree index, not file size.
// Larger individual records/trees need a paged on-disk index rather than a
// larger whole-file allocation. Returned message text still scales with history.
const maxNativeEntryBytes = 64 * 1024 * 1024
const maxNativeEntries = 1_000_000

async function* nativeLines(file: FileHandle, size: number, signal?: AbortSignal): AsyncGenerator<{ line: Buffer; offset: number }> {
  let parts: Buffer[] = []
  let length = 0
  let offset = 0
  let position = 0
  while (position < size) {
    signal?.throwIfAborted()
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) throw new Error('Pi 原生会话在读取期间发生变化，请重新打开会话')
    position += bytesRead
    const buffer = chunk.subarray(0, bytesRead)
    let start = 0
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start)
      const end = newline === -1 ? buffer.length : newline + 1
      const part = buffer.subarray(start, end)
      length += part.length
      if (length > maxNativeEntryBytes) throw new Error('Pi 原生会话单条记录超过 64 MiB')
      parts.push(part)
      if (newline !== -1) {
        yield { line: Buffer.concat(parts, length), offset }
        offset += length
        parts = []
        length = 0
      }
      start = end
    }
  }
  if (length) yield { line: Buffer.concat(parts, length), offset }
}

export async function readPiNativeHistory(args: Parameters<typeof readPiNativeSession>[0]): Promise<LoadedSessionTurn[] | null> {
  args.signal?.throwIfAborted()
  const source = await locatePiNativeSession(args)
  if (!source) return null
  const file = await open(source.canonical, 'r')
  try {
    const before = await file.stat()
    const byId = new Map<string, NativeEntryLocation>()
    let leaf: NativeEntryLocation | undefined
    let hasHeader = false
    for await (const { line, offset } of nativeLines(file, before.size, args.signal)) {
      args.signal?.throwIfAborted()
      const text = line.toString('utf8')
      if (!text.trim()) continue
      const entry = JSON.parse(text) as NativeEntry
      if (!hasHeader) {
        validateHeader(entry, args)
        hasHeader = true
        continue
      }
      if (typeof entry.id !== 'string' || byId.has(entry.id)) throw new Error('Pi 原生会话 entry id 无效')
      if (byId.size >= maxNativeEntries) throw new Error('Pi 原生会话记录数超过 1000000 条')
      leaf = { id: entry.id, parentId: entry.parentId, offset, length: line.length }
      byId.set(entry.id, leaf)
    }
    if (!hasHeader) validateHeader(undefined, args)
    const turns: LoadedSessionTurn[] = []
    for (const entry of nativeBranch(byId, leaf)) {
      // Positional reads hydrate only the selected ancestry, in branch order.
      const buffer = Buffer.allocUnsafe(entry.length)
      let read = 0
      while (read < buffer.length) {
        args.signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, entry.offset + read)
        if (bytesRead === 0) throw new Error('Pi 原生会话在读取期间发生变化，请重新打开会话')
        read += bytesRead
      }
      appendNativeEntry(turns, JSON.parse(buffer.toString('utf8')) as NativeEntry)
    }
    args.signal?.throwIfAborted()
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Pi 原生会话在读取期间发生变化，请重新打开会话')
    }
    return turns
  } finally {
    await file.close()
  }
}
