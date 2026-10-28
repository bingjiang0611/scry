import { extractUserText } from './normalize'
import { open } from 'node:fs/promises'

export function hookString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function isSyntheticPromptHook(input: Record<string, unknown>): boolean {
  const origin = input.origin
  const originKind = origin && typeof origin === 'object' && !Array.isArray(origin)
    ? hookString(origin as Record<string, unknown>, 'kind')
    : undefined
  const prompt = hookString(input, 'prompt')
  return originKind === 'task-notification' || prompt?.trimStart().startsWith('<task-notification>') === true
}

export function nativeProviderTurnId(input: Record<string, unknown>): string | undefined {
  // Claude Code exposes this identity at runtime before the SDK HookInput type catches up.
  // The transcript persists this identity as promptId, so prefer prompt-shaped
  // fields when a runtime payload happens to expose both prompt and turn ids.
  return hookString(input, 'prompt_id', 'promptId', 'prompt_event_id', 'promptEventId', 'turn_id', 'turnId')
}

const CLAUDE_TRANSCRIPT_IDENTITY_REWIND_BYTES = 256 * 1024
const CLAUDE_TRANSCRIPT_IDENTITY_SCAN_BYTES = 2 * 1024 * 1024

function transcriptPromptCandidates(text: string): string[] {
  const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(text)
  return [
    text,
    ...(command ? [`${command[1]}${command[2].trim() ? ` ${command[2].trim()}` : ''}`] : [])
  ]
}

export function claudeTranscriptProviderTurnId(
  content: string,
  prompt: string,
  sessionId?: string
): string | undefined {
  const matches = new Set<string>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (entry.type !== 'user') continue
    if (sessionId && hookString(entry, 'sessionId', 'session_id') !== sessionId) continue
    const text = extractUserText((entry.message as Record<string, unknown> | undefined)?.content)
    if (isSyntheticPromptHook({ ...entry, prompt: text })) continue
    if (!transcriptPromptCandidates(text).includes(prompt)) continue
    const identity = nativeProviderTurnId(entry)
    if (identity) matches.add(identity)
  }
  return matches.size === 1 ? [...matches][0] : undefined
}

export interface TranscriptBaseline {
  size: number
  dev: number | null
  ino: number | null
  absent: boolean
}

export async function transcriptBaseline(path: string): Promise<TranscriptBaseline | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      return { size: stat.size, dev: stat.dev, ino: stat.ino, absent: false }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { size: 0, dev: null, ino: null, absent: true }
    }
    // A transient open/stat failure is not proof of an empty transcript. Starting
    // from zero here could bind an older identical prompt after the file recovers.
    return undefined
  }
}

export async function providerTurnIdFromTranscript(
  path: string,
  prompt: string,
  sessionId: string | undefined,
  baseline: TranscriptBaseline
): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!baseline.absent && (stat.dev !== baseline.dev || stat.ino !== baseline.ino)) return undefined
      if (stat.size < baseline.size) return undefined
      const size = stat.size
      const hookOffset = baseline.size
      const readStart = Math.max(0, hookOffset - CLAUDE_TRANSCRIPT_IDENTITY_REWIND_BYTES)
      const length = Math.min(size - readStart, CLAUDE_TRANSCRIPT_IDENTITY_SCAN_BYTES)
      if (length <= 0) return undefined
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, readStart)
      const bytes = buffer.subarray(0, bytesRead)
      const lines: string[] = []
      let lineStart = 0
      if (readStart > 0) {
        const firstNewline = bytes.indexOf(0x0a)
        if (firstNewline < 0) return undefined
        lineStart = firstNewline + 1
      }
      for (;;) {
        const newline = bytes.indexOf(0x0a, lineStart)
        if (newline < 0) break
        const absoluteEnd = readStart + newline + 1
        if (absoluteEnd > hookOffset) lines.push(bytes.subarray(lineStart, newline).toString('utf8'))
        lineStart = newline + 1
      }
      return claudeTranscriptProviderTurnId(lines.join('\n'), prompt, sessionId)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}
