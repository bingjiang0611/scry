// Pi native session records → conversation turns. Pure parsing and projection only:
// the bounded on-disk reader and its cache live in `pi-native-session-file.ts`.

import type { LoadedSessionTurn } from './session-history'
import { classifyTool, type TraceEvent } from '../shared/trace'
import { historyCopy } from '../shared/constants/copy'

export interface NativeEntry {
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
    /** The Pi runtime's own terminal marker for this assistant message. */
    stopReason?: string
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

export function validateHeader(header: NativeEntry | undefined, identity: { sessionId: string; cwd: string }): void {
  if (header?.type !== 'session' || header.version !== 3 || header.id !== identity.sessionId ||
      header.cwd !== identity.cwd) throw new Error('Pi 原生会话身份或格式不匹配')
}

export function nativeBranch<T extends Pick<NativeEntry, 'id' | 'parentId'>>(byId: Map<string, T>, leaf: T | undefined): T[] {
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

export function appendNativeEntry(turns: LoadedSessionTurn[], current: NativeEntry): void {
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
    // Only the turn's last assistant message speaks for it: an intermediate one
    // stops at `toolUse`, not at `stop`.
    turn.stopReason = typeof message.stopReason === 'string' && message.stopReason.trim()
      ? message.stopReason.trim()
      : undefined
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

export interface NativeEntryMetadata extends Pick<NativeEntry, 'id' | 'parentId' | 'type' | 'timestamp'> {
  role?: string
  stopReason?: string
  userText?: string
  blocks?: Array<{ type: string; id?: string; name?: string }>
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface NativeEntryLocation extends Pick<NativeEntry, 'id' | 'parentId'> {
  offset: number
  length: number
  metadata: NativeEntryMetadata
}

export function metadataForEntry(entry: NativeEntry): NativeEntryMetadata {
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
    stopReason: typeof message?.stopReason === 'string' && message.stopReason.trim() ? message.stopReason.trim() : undefined,
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
    turn.stopReason = current.stopReason
    for (const block of current.blocks ?? []) if (block.type === 'toolCall' && block.id) emit('tool_call', block.id)
  } else if (current.role === 'toolResult' && current.toolCallId) emit('tool_result', current.toolCallId)
}

export function metadataTurns(entries: Map<string, NativeEntryLocation>, leaf: NativeEntryLocation | undefined): LoadedSessionTurn[] {
  const turns: LoadedSessionTurn[] = []
  for (const location of nativeBranch(entries, leaf)) appendNativeMetadata(turns, location.metadata)
  return turns
}
