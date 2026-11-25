import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace'
import { shellEnv } from '../login-shell-env'
import { antigravityEffectiveGeminiRoot } from './antigravity-mcp-paths'

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024

export async function observeAntigravityTranscriptModel(args: {
  sessionId: string
  startedAt?: string
  result?: TraceEvent
  outputTokens?: number
}): Promise<string | undefined> {
  const { sessionId, startedAt, result, outputTokens } = args
  if (!startedAt || !result || result.isError || !outputTokens || result.tokensOut !== outputTokens ||
    result.runtimeMetadata?.usageCoverage !== 'available') return
  try {
    return await readAntigravityTranscriptModel({
      geminiRoot: antigravityEffectiveGeminiRoot(homedir(), { ...shellEnv(), ...process.env }),
      sessionId, startedAt: Date.parse(startedAt), endedAt: Date.parse(result.ts), outputTokens
    })
  } catch {
    // Optional local evidence: missing or invalid logs never change the recorded usage or timing.
    return undefined
  }
}

async function readAntigravityTranscriptModel(args: {
  geminiRoot: string
  sessionId: string
  startedAt: number
  endedAt: number
  outputTokens: number
}): Promise<string | undefined> {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(args.sessionId) ||
    !Number.isFinite(args.startedAt) || !Number.isFinite(args.endedAt) || args.endedAt < args.startedAt ||
    !Number.isSafeInteger(args.outputTokens) || args.outputTokens <= 0) return

  const root = await realpath(args.geminiRoot)
  const parent = join(root, 'antigravity-cli', 'brain', args.sessionId, '.system_generated', 'logs')
  if (await realpath(parent) !== parent) return
  const file = await open(join(parent, 'transcript.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let text: string
  try {
    const info = await file.stat()
    if (!info.isFile()) return
    const offset = Math.max(0, info.size - MAX_TRANSCRIPT_BYTES)
    const bytes = Buffer.alloc(info.size - offset)
    for (let read = 0; read < bytes.length;) {
      const chunk = await file.read(bytes, read, bytes.length - read, offset + read)
      if (!chunk.bytesRead) return
      read += chunk.bytesRead
    }
    // The transcript is append-only. Never parse a line cut by the bounded read.
    const first = offset ? bytes.indexOf(10) : -1
    const last = bytes.lastIndexOf(10)
    if (last <= first || (offset && first === -1)) return
    text = bytes.toString('utf8', first + 1, last)
  } finally {
    await file.close()
  }

  // agy timestamps have second precision. More than one candidate input is ambiguous.
  const lower = Math.floor(args.startedAt / 1000) * 1000
  let input = false
  let lastStep: number | undefined
  let tokens = 0
  let model: string | undefined
  // 一轮里换了模型时，按输出 Token 归到最多的那个（Q11），不再写成「多模型」。
  const outputByModel = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const step: unknown = JSON.parse(line)
    if (!step || typeof step !== 'object') return
    const row = step as Record<string, unknown>
    const time = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN
    if (!Number.isFinite(time)) return
    if (time < lower || time > args.endedAt) continue
    const index = row.step_index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) ||
      (lastStep !== undefined && index !== lastStep + 1)) return
    lastStep = index
    if (row.type === 'USER_INPUT') {
      if (input) return
      input = true
    } else if (row.type === 'PLANNER_RESPONSE') {
      const output = row.output_tokens
      const id = row.model
      if (!input || typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id) ||
        typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) return
      tokens += output
      outputByModel.set(id, (outputByModel.get(id) ?? 0) + output)
      model ??= id
    }
  }
  if (tokens !== args.outputTokens) return
  if (outputByModel.size > 1) {
    return [...outputByModel].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
  }
  return model
}
