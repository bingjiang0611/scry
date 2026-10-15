import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
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
  const header = entries.shift()
  if (header?.type !== 'session' || header.version !== 3 || header.id !== identity.sessionId ||
      header.cwd !== identity.cwd) throw new Error('Pi 原生会话身份或格式不匹配')
  const byId = new Map<string, NativeEntry>()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || byId.has(entry.id)) throw new Error('Pi 原生会话 entry id 无效')
    byId.set(entry.id, entry)
  }
  const chain: NativeEntry[] = []
  const visited = new Set<string>()
  let entry = entries.at(-1)
  while (entry) {
    if (visited.has(entry.id!)) throw new Error('Pi 原生会话分支存在循环')
    visited.add(entry.id!)
    chain.push(entry)
    if (entry.parentId === null) break
    if (typeof entry.parentId !== 'string' || !byId.has(entry.parentId)) throw new Error('Pi 原生会话分支不完整')
    entry = byId.get(entry.parentId)
  }
  const turns: LoadedSessionTurn[] = []
  let turn: LoadedSessionTurn | undefined
  for (const current of chain.reverse()) {
    if (current.type !== 'message' || !current.message) continue
    const message = current.message
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    if (message.role === 'user') {
      turn = { runId: `pi-native-${current.id}`, userText: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
        items: [], errorHint: recoveryNotice }
      if (blocks.some((block) => block.type === 'image')) turn.errorHint += ' 原始图片未恢复。'
      turns.push(turn)
      continue
    }
    if (!turn) continue
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
  return turns
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
// Bound full-file parsing at 64 MiB; larger histories require a streaming reader.
export async function readPiNativeSession(args: {
  sessionRoot: string
  cwd: string
  sessionId: string
  signal?: AbortSignal
  maxBytes?: number
}): Promise<string | null> {
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
  if (info.size > 64 * 1024 * 1024) throw new Error('Pi 原生会话超过 64 MiB，只读恢复需要流式读取')
  if (args.maxBytes != null && info.size > args.maxBytes) throw new Error('Pi metering aggregate byte budget reached')
  return readFile(canonical, { encoding: 'utf8', signal: args.signal })
}

export async function readPiNativeHistory(args: Parameters<typeof readPiNativeSession>[0]): Promise<LoadedSessionTurn[] | null> {
  const content = await readPiNativeSession(args)
  return content == null ? null : parsePiNativeHistory(content, args)
}
