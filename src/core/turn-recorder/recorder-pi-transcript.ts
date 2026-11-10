import { open as openFile } from 'node:fs/promises'
import { recordTranscriptAnchorBytes } from './recorder-transcript-io.js'
import type { TraceEvent } from '../../shared/trace.js'
import { classifyTool, fileOpOf, parseMcp } from '../../shared/trace.js'
import { classifyDanger } from '../../main/danger.js'
import type { PiTranscriptAnchor, TranscriptRead } from './recorder-contracts.js'
import { stableHash } from './store.js'

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  cwd?: string
  version?: number
  message?: {
    role?: string
    content?: string | Array<Record<string, unknown>>
    toolCallId?: string
    toolName?: string
    isError?: boolean
    stopReason?: string
  }
}

function textOf(content: NonNullable<PiEntry['message']>['content']): string {
  if (typeof content === 'string') return content
  return (content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text)).join('')
}

function blocksOf(content: NonNullable<PiEntry['message']>['content']): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content : []
}

function terminalOf(reason: string | undefined): 'completed' | 'interrupted' | 'failed' | undefined {
  if (!reason) return undefined
  const normalized = reason.toLowerCase()
  if (normalized.includes('error') || normalized.includes('fail')) return 'failed'
  if (normalized.includes('abort') || normalized.includes('cancel')) return 'interrupted'
  if (['stop', 'end_turn', 'completed', 'complete', 'done'].includes(normalized)) return 'completed'
  return undefined
}

function emptyRead(identityMatched = false): TranscriptRead {
  return {
    stable: true,
    observed: true,
    identityMatched,
    complete: false,
    events: [],
    observable: { tools: true, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: true }
  }
}

/** Parse only the ancestry between the bridge's before/after native entries. */
export function parsePiTranscript(
  content: string,
  runId: string,
  anchor: PiTranscriptAnchor | undefined,
  identity?: { sessionId?: string; cwd?: string }
): TranscriptRead {
  if (!anchor || !anchor.afterEntryId) return emptyRead(false)
  const entries: PiEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as PiEntry) } catch { return emptyRead(false) }
  }
  const header = entries[0]
  if (header?.type !== 'session' || (
    header.version !== 3 ||
    (identity?.sessionId !== undefined && header.id !== identity.sessionId) ||
    (identity?.cwd !== undefined && header.cwd !== identity.cwd)
  )) return emptyRead(false)
  const byId = new Map(entries.filter(entry => typeof entry.id === 'string').map(entry => [entry.id!, entry]))
  const leaf = byId.get(anchor.afterEntryId)
  if (!leaf) return emptyRead(false)
  const chain: PiEntry[] = []
  const visited = new Set<string>()
  let current: PiEntry | undefined = leaf
  while (current?.id) {
    if (visited.has(current.id)) return emptyRead(false)
    visited.add(current.id)
    if (current.id === anchor.beforeEntryId) break
    chain.push(current)
    if (current.parentId === null) break
    if (typeof current.parentId !== 'string') return emptyRead(false)
    current = byId.get(current.parentId)
    if (!current) return emptyRead(false)
  }
  if (anchor.beforeEntryId !== null && current?.id !== anchor.beforeEntryId) return emptyRead(false)
  chain.reverse()
  const user = chain.find(entry => entry.type === 'message' && entry.message?.role === 'user')
  // Pi also starts real runs from extension-authored custom messages. Preserve
  // those native boundaries without inventing a human prompt or another turn.
  const start = user ?? chain.find(entry => entry.type === 'custom_message')
  if (!start?.id) return emptyRead(false)
  const events: TraceEvent[] = []
  const rootUserText = user ? textOf(user.message?.content) : undefined
  const startedAt = start.timestamp && Number.isFinite(Date.parse(start.timestamp)) ? new Date(start.timestamp).toISOString() : undefined
  let completedAt: string | undefined
  let terminalStatus: TranscriptRead['terminalStatus']
  let files = false
  let mcps = false
  const add = (entry: PiEntry, index: number, fields: Partial<TraceEvent> & Pick<TraceEvent, 'kind' | 'stage'>): void => {
    if (!entry.id || !entry.timestamp || !Number.isFinite(Date.parse(entry.timestamp))) return
    const at = new Date(entry.timestamp).toISOString()
    events.push({
      id: `pi-transcript-${stableHash([entry.id, index, fields.stage]).slice(0, 20)}`,
      ts: at,
      runId,
      providerId: 'pi',
      runtimeProvider: 'pi_rpc',
      runtimeMetadata: { source: 'pi_native_transcript', nativeEntryId: entry.id },
      ...fields
    })
  }
  let userSeen = false
  chain.forEach((entry) => {
    // Pi compacts in place on the ancestry chain; the anchored range already proves this
    // event belongs to the turn, so project it instead of reconstructing one from hooks.
    if (entry.type === 'compaction') {
      add(entry, 0, { kind: 'harness', stage: 'context_compaction', compaction: {} })
      return
    }
    if (entry.type !== 'message' || !entry.message) return
    const message = entry.message
    if (message.role === 'user') {
      if (userSeen && entry.id && entry.id !== user?.id) {
        add(entry, 0, {
          kind: 'human',
          stage: 'steer',
          steer: {
            messageId: entry.id,
            prompt: textOf(message.content),
            attachments: [],
            status: 'accepted',
            providerTurnId: start.id
          }
        })
      }
      userSeen = true
      return
    }
    if (message.role === 'assistant') {
      const reason = terminalOf(message.stopReason)
      if (reason) {
        terminalStatus = reason
        if (entry.timestamp && Number.isFinite(Date.parse(entry.timestamp))) completedAt = new Date(entry.timestamp).toISOString()
      }
      blocksOf(message.content).forEach((block, index) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          add(entry, index, { kind: 'model', stage: 'text', text: block.text, messageId: entry.id })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          add(entry, index, { kind: 'model', stage: 'thinking', thinking: block.thinking, messageId: entry.id })
        } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
          const tool = block.name === 'subagent' ? 'Agent' : block.name
          const input = block.arguments && typeof block.arguments === 'object' ? block.arguments as Record<string, unknown> : {}
          const classified = classifyTool(tool, input)
          const mcp = parseMcp(tool, input)
          const file = fileOpOf(tool, input)
          const danger = classifyDanger(tool, input)
          files ||= !!file.filePath
          mcps ||= !!mcp.mcpServer
          add(entry, index, {
            kind: classified.kind,
            stage: `${classified.kind}:${classified.name}`,
            name: classified.name,
            tool,
            toolUseId: block.id,
            input,
            ...mcp,
            ...file,
            ...(danger ? { danger } : {})
          })
        }
      })
      return
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const output = textOf(message.content)
      add(entry, 0, {
        kind: 'tool',
        stage: 'tool_result',
        toolUseId: message.toolCallId,
        tool: message.toolName,
        output,
        text: output,
        isError: message.isError
      })
    }
  })
  return {
    stable: true,
    observed: true,
    identityMatched: true,
    providerTurnId: start.id,
    complete: !!terminalStatus,
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(rootUserText ? { userText: rootUserText } : {}),
    events,
    observable: { tools: true, skills: false, mcps: mcps || false, hooks: false, usage: false, files, errors: true }
  }
}

export async function piTranscriptOffsets(path: string, endOffset: number, anchor: PiTranscriptAnchor): Promise<{ startOffset: number; endOffset: number }> {
  let startOffset = 0
  let boundedEnd = endOffset
  const handle = await openFile(path, 'r')
  const chunkBytes = 1024 * 1024
  let cursor = 0
  let pending = Buffer.alloc(0)
  let pendingStart = 0
  try {
    while (cursor < endOffset) {
      const length = Math.min(chunkBytes, endOffset - cursor)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, cursor)
      if (bytesRead !== length) break
      recordTranscriptAnchorBytes(bytesRead)
      const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let lineStart = 0
      for (;;) {
        const newline = combined.indexOf(0x0a, lineStart)
        if (newline < 0) break
        let row: Record<string, unknown> | undefined
        try { row = JSON.parse(combined.subarray(lineStart, newline).toString('utf8')) as Record<string, unknown> } catch {}
        const id = typeof row?.id === 'string' ? row.id : undefined
        const absoluteStart = pendingStart + lineStart
        if (anchor.beforeEntryId && id === anchor.beforeEntryId) startOffset = Math.max(0, absoluteStart - 1)
        if (anchor.afterEntryId && id === anchor.afterEntryId) boundedEnd = pendingStart + newline + 1
        lineStart = newline + 1
      }
      pending = Buffer.from(combined.subarray(lineStart))
      pendingStart += lineStart
      cursor += bytesRead
    }
    if (pending.length) {
      let row: Record<string, unknown> | undefined
      try { row = JSON.parse(pending.toString('utf8')) as Record<string, unknown> } catch {}
      const id = typeof row?.id === 'string' ? row.id : undefined
      if (anchor.beforeEntryId && id === anchor.beforeEntryId) startOffset = Math.max(0, pendingStart - 1)
      if (anchor.afterEntryId && id === anchor.afterEntryId) boundedEnd = pendingStart + pending.length
    }
  } finally {
    await handle.close()
  }
  return { startOffset, endOffset: boundedEnd }
}
