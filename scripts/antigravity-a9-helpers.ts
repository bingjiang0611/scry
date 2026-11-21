import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { createAntigravityAdapter } from '../src/main/providers/antigravity'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../src/shared/runtime'
import type { TraceEvent } from '../src/shared/trace'

export const EVIDENCE_DIR = join(homedir(), '.local/state/scry-handoff-evidence/W8')
mkdirSync(EVIDENCE_DIR, { recursive: true })

export function saveEvidence(name: string, data: unknown): void {
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function psCommandLines(matchSubstr: string): string[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid,ppid,pgid,command'], { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.includes(matchSubstr))
  } catch {
    return []
  }
}

export function answerQuestion(
  req: AgentQuestionRequest,
  pick: (options: AgentQuestionRequest['questions'][number]['options']) => string | undefined
): AgentQuestionResponse {
  const q = req.questions[0]
  if (!q) return { behavior: 'cancelled' }
  const chosen = pick(q.options) ?? q.options[0]?.answerValue ?? q.options[0]?.label
  if (!chosen) return { behavior: 'cancelled' }
  return { behavior: 'answered', answers: { [q.question]: chosen } }
}

export const pickAllow = (req: AgentQuestionRequest): AgentQuestionResponse =>
  answerQuestion(req, (opts) =>
    opts.find((o) => /allow|允许/i.test(o.answerValue ?? '') || /allow|允许/i.test(o.label))?.answerValue
  )

export const pickReject = (req: AgentQuestionRequest): AgentQuestionResponse =>
  answerQuestion(req, (opts) =>
    opts.find((o) => /reject|deny|拒绝/i.test(o.answerValue ?? '') || /reject|deny|拒绝/i.test(o.label))?.answerValue
  )

export async function runOne(
  adapter: ReturnType<typeof createAntigravityAdapter>,
  opts: {
    cwd: string
    prompt: string
    permissionMode?: 'default' | 'auto_accept_edits' | 'full_access'
    resume?: string
    model?: { id: string }
    effort?: string
    historyReader?: { url: string; token: string; serverName: string }
    onEvent?: (event: TraceEvent, handle: ReturnType<ReturnType<typeof createAntigravityAdapter>['run']>) => void
    onQuestion?: (req: AgentQuestionRequest) => AgentQuestionResponse
  }
) {
  const events: TraceEvent[] = []
  const nativeEvents: Array<{ type: string; payload: unknown }> = []
  const questions: AgentQuestionRequest[] = []
  let externalSessionId: string | undefined
  const handle = adapter.run({
    runId: `a9-${randomUUID().slice(0, 8)}`,
    prompt: opts.prompt,
    cwd: opts.cwd,
    attachments: [],
    permissionMode: opts.permissionMode ?? 'default',
    resume: opts.resume,
    model: opts.model,
    effort: opts.effort,
    historyReader: opts.historyReader,
    emit: (event) => {
      events.push(event)
      opts.onEvent?.(event, handle)
    },
    recordNative: (type, payload) => {
      nativeEvents.push({ type, payload })
    },
    onExternalSessionId: (sid) => {
      externalSessionId = sid
    },
    requestUserInput: async (req) => {
      questions.push(req)
      if (opts.onQuestion) return opts.onQuestion(req)
      return pickReject(req)
    }
  })
  const result = await handle.promise
  const text = events.filter((e) => e.kind === 'model' && e.stage === 'text_delta').map((e) => e.text ?? '').join('')
  const thinking = events.filter((e) => e.kind === 'model' && e.stage === 'thinking').map((e) => e.thinking ?? e.text ?? '').join('')
  const toolMetaById = new Map<string, Record<string, unknown>>()
  for (const e of events) {
    if (e.kind === 'tool' && e.toolUseId && e.runtimeMetadata) {
      toolMetaById.set(e.toolUseId, { ...(toolMetaById.get(e.toolUseId) ?? {}), ...(e.runtimeMetadata as Record<string, unknown>) })
    }
  }
  const tools = events.filter((e) => e.kind === 'tool' && e.stage === 'tool_use').map((e) => {
    const mergedMeta = e.toolUseId ? toolMetaById.get(e.toolUseId) : (e.runtimeMetadata as Record<string, unknown> | undefined)
    return {
      id: e.toolUseId,
      name: e.tool ?? e.name,
      approvalSource: mergedMeta?.approvalSource,
      approvalLabel: mergedMeta?.approvalLabel
    }
  })
  const resultEvent = [...events].reverse().find((e) => e.kind === 'harness' && e.stage === 'result')
  const meta = resultEvent?.runtimeMetadata as Record<string, unknown> | undefined
  return {
    result,
    externalSessionId: externalSessionId ?? handle.getExternalSessionId(),
    text,
    thinkingLen: thinking.length,
    tools,
    questions,
    usage: resultEvent ? {
      tokensIn: resultEvent.tokensIn ?? null,
      tokensOut: resultEvent.tokensOut ?? null,
      cacheReadTokens: resultEvent.cacheReadTokens ?? null,
      cacheCreationTokens: resultEvent.cacheCreationTokens ?? null,
      reasoningTokens: resultEvent.reasoningTokens ?? null
    } : null,
    costUsd: resultEvent?.costUsd ?? null,
    modelStatus: meta?.modelStatus,
    usageCoverage: meta?.usageCoverage,
    effectivePermissionMode: meta?.effectivePermissionMode,
    userAllowNotice: meta?.userAllowNotice,
    nativeCount: nativeEvents.length,
    eventsCount: events.length
  }
}
