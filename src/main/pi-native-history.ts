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

// Pi's adapter uses the native user entry ID as providerTurnId. Prefer canonical
// Scry evidence only at that exact boundary; same-text prompts prove nothing.
export function reconcilePiNativeHistory(native: LoadedSessionTurn[], archived: LoadedSessionTurn[]): LoadedSessionTurn[] {
  const byRunId = new Map(native.map((turn) => [turn.runId, [turn]]))
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
  return [...native.flatMap((turn) => byRunId.get(turn.runId)!), ...unlinked]
}

// Offline fallback for catalog-authorized Pi sessions only. No launcher/config
// execution and no renderer-supplied path. Default Pi layout (session-manager).
// Custom profile-owned session roots remain unavailable rather than guessed.
// Bound full-file parsing at 64 MiB; larger histories require a streaming reader.
export async function readPiNativeHistory(args: {
  sessionRoot: string
  cwd: string
  sessionId: string
  signal?: AbortSignal
}): Promise<LoadedSessionTurn[] | null> {
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
  const content = await readFile(canonical, { encoding: 'utf8', signal: args.signal })
  return parsePiNativeHistory(content, args)
}
