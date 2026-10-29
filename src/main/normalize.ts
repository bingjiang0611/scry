// 把 Claude Agent SDK 的 message stream（和 subagent transcript 行）归一化成统一 TraceEvent。
// 纯函数、不依赖 electron/SDK 运行时 —— 便于 vitest 单测（见 normalize.test.ts）。

import type { ModelUsageRow, TraceEvent } from '../shared/trace.js'
import { classifyRunTermination } from '../shared/runtime.js'
import { claudeTranscriptUsageKey } from '../shared/usage-dedupe.js'
import { mcpPayloadFailed } from '../shared/trace.js'
import {
  base,
  contextTokensFromUsage,
  injectedSkillName,
  normalizeBlocks,
  skillInjectionEvent,
  type Block,
  type NormalizeCtx,
  stringValue,
  transcriptUsageResult
} from './normalize-core.js'
import { normalizeHookAttachment, normalizeHookMessage } from './normalize-hooks.js'

// The hook/agent-task context shape is shared with agent-runner, so it stays
// visible from here even though the primitives live in their own module.
export type { NormalizeCtx } from './normalize-core.js'

// SDK message → TraceEvent[]
export function normalizeSdkMessage(msg: unknown, ctx: NormalizeCtx): TraceEvent[] {
  const m = msg as Record<string, unknown>
  if (!m || typeof m !== 'object') return []
  if (m.type === 'system') return normalizeHookMessage(m, ctx)
  if (m.type === 'attachment') return normalizeHookAttachment(m, ctx)
  if (m.type === 'assistant') {
    const msg = m.message as Record<string, unknown> | undefined
    const ctxTokens = ctx.contextTokensFromUsage?.(msg?.usage) ?? contextTokensFromUsage(msg?.usage)
    if (ctxTokens > 0) {
      ctx.latestContextTokens = ctxTokens
      ctx.latestContextModel = typeof msg?.model === 'string' && msg.model ? msg.model : undefined
    }
    const content = msg?.content as Block[] | undefined
    if (Array.isArray(content)) {
      return normalizeBlocks(content, (m.parent_tool_use_id as string | null) ?? null, ctx, msg?.id as string | undefined)
    }
  }
  if (m.type === 'user') {
    // SDK 在 user message 里回传工具结果（tool_result），生成事件供 renderer 合并进对应 tool_use
    const content = (m.message as Record<string, unknown> | undefined)?.content
    if (Array.isArray(content)) {
      const out: TraceEvent[] = []
      const resultBlocks = (content as Array<Record<string, unknown>>).filter((block) => block.type === 'tool_result')
      const outerFailure = outerToolResultFailure(m)
      const outerResult = outerToolResultRecord(m)
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') {
          const name = injectedSkillName(b.text)
          if (name) out.push(...skillInjectionEvent(ctx, name, { source: 'skill_injection' }))
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const toolUseId = String(b.tool_use_id)
          const started = ctx.toolUseById?.get(toolUseId)
          ctx.toolUseById?.delete(toolUseId)
          const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          const outerResultToolUseId = stringValue(outerResult?.toolUseId ?? outerResult?.tool_use_id)
          const resultMetadataApplies = outerResultToolUseId
            ? outerResultToolUseId === toolUseId
            : resultBlocks.length === 1
          const agentResultStatus = started?.kind === 'agent' && resultMetadataApplies
            ? stringValue(outerResult?.status)
            : undefined
          if (agentResultStatus === 'async_launched' || agentResultStatus === 'remote_launched') {
            const taskId = stringValue(
              outerResult?.taskId ?? outerResult?.task_id ?? outerResult?.agentId ?? outerResult?.agent_id
            )
            if (taskId) (ctx.agentTaskToolUseById ??= new Map()).set(taskId, toolUseId)
          }
          out.push(
            base(ctx, {
              kind: 'tool',
              stage: 'tool_result',
              toolUseId,
              tool: started?.tool,
              name: started?.name,
              isMcp: started?.isMcp,
              mcpServer: started?.mcpServer,
              mcpAction: started?.mcpAction,
              mcpTool: started?.mcpTool,
              mcpCalls: started?.mcpCalls,
              fileOp: started?.fileOp,
              filePath: started?.filePath,
              text: output,
              output,
              isError: b.is_error === true ||
                (outerFailure?.failed === true && (
                  outerFailure.toolUseId === toolUseId ||
                  (!outerFailure.toolUseId && resultBlocks.length === 1)
                )) ||
                (started?.isMcp === true && mcpPayloadFailed(output)),
              ...(agentResultStatus ? {
                runtimeMetadata: { source: 'provider_agent_result', agentStatus: agentResultStatus }
              } : {})
            })
          )
        }
      }
      return out
    }
  }
  if (m.type === 'stream_event') {
    // A text delta is a chunk, not one token. Retain native message identity for timing.
    const e = m.event as Record<string, unknown> | undefined
    const streamKey = String(m.parent_tool_use_id ?? '')
    if (e?.type === 'message_start') {
      const message = e.message as Record<string, unknown> | undefined
      if (typeof message?.id === 'string') (ctx.streamMessageIds ??= new Map()).set(streamKey, message.id)
    }
    if (e?.type === 'message_stop') {
      const messageId = ctx.streamMessageIds?.get(streamKey)
      ctx.streamMessageIds?.delete(streamKey)
      return [base(ctx, {
        kind: 'harness', stage: 'runtime:llm_stream_end', messageId,
        parentToolUseId: (m.parent_tool_use_id as string | null) ?? null
      })]
    }
    const delta = e?.delta as Record<string, unknown> | undefined
    if (e?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [base(ctx, {
        kind: 'model',
        stage: 'text_delta',
        text: delta.text,
        messageId: ctx.streamMessageIds?.get(streamKey),
        parentToolUseId: (m.parent_tool_use_id as string | null) ?? null
      })]
    }
    return []
  }
  if (m.type === 'result') {
    const u = (m.usage as Record<string, number> | undefined) ?? {}
    const resultText = typeof m.result === 'string' && m.result.trim() ? m.result : undefined
    const resultErrors = Array.isArray(m.errors)
      ? m.errors.filter((error): error is string => typeof error === 'string' && !!error.trim())
      : []
    const providerStopReason = typeof m.stop_reason === 'string' && m.stop_reason.trim()
      ? m.stop_reason.trim()
      : typeof m.terminal_reason === 'string' && m.terminal_reason.trim()
        ? m.terminal_reason.trim()
        : undefined
    const terminationReason = classifyRunTermination({
      rawReason: providerStopReason,
      subtype: m.subtype,
      message: resultErrors.join('\n') || resultText
    })
    // probe 实测：modelUsage 是会话级更完整的 SDK usage 聚合，顶层 usage.input_tokens 会少算（只末轮）。
    // 故 token 从 modelUsage 求和；缺 modelUsage 时退回顶层 usage。美元成本只保留 SDK 原始值，不再按公开价补估算。
    const mu = m.modelUsage as
      | Record<
          string,
          {
            inputTokens?: number
            outputTokens?: number
            cacheReadInputTokens?: number
            cacheCreationInputTokens?: number
            costUSD?: number
            contextWindow?: number
          }
        >
      | undefined
    const modelUsage: ModelUsageRow[] = []
    let tin = 0
    let tout = 0
    let cr = 0
    let cc = 0
    if (mu && typeof mu === 'object') {
      for (const [model, v] of Object.entries(mu)) {
        tin += v.inputTokens ?? 0
        tout += v.outputTokens ?? 0
        cr += v.cacheReadInputTokens ?? 0
        cc += v.cacheCreationInputTokens ?? 0
        modelUsage.push({
          model,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          cacheReadTokens: v.cacheReadInputTokens,
          cacheCreationTokens: v.cacheCreationInputTokens,
          costUsd: v.costUSD,
          costSource: v.costUSD != null ? 'sdk_estimate' : undefined,
          costConfidence: v.costUSD != null ? 'estimated' : undefined,
          costUnit: v.costUSD != null ? 'usd' : undefined,
          contextWindow: v.contextWindow
        })
      }
    }
    const hasMu = modelUsage.length > 0
    // 当前上下文占用优先取最近 assistant usage。SDK result.usage 在部分版本里是整轮累计，
    // 会把 cache_read 累到超过 context window，不能直接当"当前装了多满"。
    const fallbackCtxTokens = ctx.contextTokensFromUsage?.(u) ?? contextTokensFromUsage(u)
    const ctxTokens = ctx.latestContextTokens ?? fallbackCtxTokens
    const modelCostRows = modelUsage.filter((row) => row.costUsd != null)
    const modelCostUsd = modelCostRows.length === modelUsage.length && modelUsage.length > 0 ? modelCostRows.reduce((s, row) => s + (row.costUsd ?? 0), 0) : undefined
    const resultCostUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : modelCostUsd
    const resultCostSource = resultCostUsd != null ? 'sdk_estimate' : undefined
    const resultCostConfidence = resultCostUsd != null ? 'estimated' : undefined
    return [
      base(ctx, {
        kind: 'harness',
        stage: 'result',
        text: resultText ?? (resultErrors.length > 0 ? resultErrors.join('\n') : undefined) ?? (m.subtype as string | undefined),
        costUsd: resultCostUsd,
        costSource: resultCostSource,
        costConfidence: resultCostConfidence,
        costUnit: resultCostUsd != null ? 'usd' : undefined,
        tokensIn: hasMu ? tin : u.input_tokens,
        tokensOut: hasMu ? tout : u.output_tokens,
        cacheReadTokens: hasMu ? cr : u.cache_read_input_tokens,
        cacheCreationTokens: hasMu ? cc : u.cache_creation_input_tokens,
        ...(ctxTokens > 0 ? {
          contextTokens: ctxTokens,
          contextModel: ctx.latestContextModel ?? (modelUsage.length === 1 ? modelUsage[0].model : undefined),
          contextUsageSource: 'provider_usage',
          contextUsageQuality: 'exact' as const
        } : {}),
        durationMs: m.duration_ms as number | undefined,
        durationApiMs: m.duration_api_ms as number | undefined,
        modelUsage: hasMu ? modelUsage : undefined,
        isError: m.subtype !== 'success' || m.is_error === true,
        ...(terminationReason ? { terminationReason } : {}),
        ...(providerStopReason ? { providerStopReason } : {}),
        runtimeMetadata: {
          resultSubtype: m.subtype,
          stopReason: providerStopReason ?? null
        }
      })
    ]
  }
  return []
}

// 用户 prompt → human 事件
export function humanEvent(prompt: string, ctx: NormalizeCtx): TraceEvent {
  return base(ctx, { kind: 'human', stage: 'prompt', text: prompt.slice(0, 500) })
}

// 从 transcript 的 user message content 抽出真实用户输入文本（tool_result 回传的不算）
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find((b) => (b as Block).type === 'text') as Block | undefined
    return t?.text ?? ''
  }
  return ''
}

export interface ParsedTurn {
  userText: string
  providerTurnId?: string
  /** `stop_reason` of the last assistant message, verbatim; absent when the log never reported one. */
  stopReason?: string
  items: TraceEvent[]
}

function transcriptProviderTurnId(line: Record<string, unknown>): string | undefined {
  for (const key of ['promptId', 'prompt_id', 'turnId', 'turn_id']) {
    if (typeof line[key] === 'string' && line[key]) return line[key]
  }
  return undefined
}

function isClaudeTaskNotification(line: Record<string, unknown>, text: string): boolean {
  const origin = line.origin
  const originKind = origin && typeof origin === 'object' && !Array.isArray(origin)
    ? (origin as Record<string, unknown>).kind
    : undefined
  return originKind === 'task-notification' || text.trimStart().startsWith('<task-notification>')
}

function outerToolResultRecord(message: Record<string, unknown>): Record<string, unknown> | undefined {
  let raw = message.toolUseResult ?? message.tool_use_result
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown } catch { return undefined }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function outerToolResultFailure(message: Record<string, unknown>): { failed: boolean; toolUseId?: string } | undefined {
  const result = outerToolResultRecord(message)
  if (!result) return undefined
  const exitCode = typeof result.exitCode === 'number'
    ? result.exitCode
    : typeof result.exit_code === 'number'
      ? result.exit_code
      : undefined
  const toolUseId = typeof result.toolUseId === 'string'
    ? result.toolUseId
    : typeof result.tool_use_id === 'string'
      ? result.tool_use_id
      : undefined
  return {
    toolUseId,
    failed: result.isError === true ||
      result.is_error === true ||
      result.kind === 'failed' ||
      result.status === 'failed' ||
      (exitCode != null && exitCode !== 0)
  }
}

function transcriptContextForLine(ctx: NormalizeCtx, line: Record<string, unknown>): NormalizeCtx {
  const timestamp = typeof line.timestamp === 'string' && Number.isFinite(Date.parse(line.timestamp)) ? line.timestamp : undefined
  return timestamp ? { ...ctx, now: () => timestamp } : ctx
}

function syncTranscriptContext(ctx: NormalizeCtx, lineCtx: NormalizeCtx): void {
  if (lineCtx === ctx) return
  ctx.latestContextTokens = lineCtx.latestContextTokens
  ctx.latestContextModel = lineCtx.latestContextModel
  ctx.lastSkillName = lineCtx.lastSkillName
  ctx.toolUseById = lineCtx.toolUseById
  ctx.agentToolUseIds = lineCtx.agentToolUseIds
  ctx.agentTaskToolUseById = lineCtx.agentTaskToolUseById
}

export interface TranscriptParseState {
  turns: ParsedTurn[]
  cur: ParsedTurn | null
  pendingBeforeFirstTurn: TraceEvent[]
  suppressMetaAssistant: boolean
  seenAssistantUsage: Set<string>
}

export function createTranscriptParseState(): TranscriptParseState {
  return { turns: [], cur: null, pendingBeforeFirstTurn: [], suppressMetaAssistant: false,
    seenAssistantUsage: new Set() }
}

// The whole-document and incremental readers share this exact reducer. Only
// newline-complete records are committed by the file cache; a tail is previewed
// on a fork so subsequent writes cannot duplicate usage or tool lifecycles.
export function appendTranscriptToTurns(content: string, ctx: NormalizeCtx, state: TranscriptParseState): ParsedTurn[] {
  const { turns, seenAssistantUsage } = state
  let { cur, pendingBeforeFirstTurn, suppressMetaAssistant } = state
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const lineCtx = transcriptContextForLine(ctx, o)
    try {
      if (o.type === 'user') {
        if (o.isCompactSummary === true) {
          suppressMetaAssistant = false
          continue
        }
        const text = extractUserText((o.message as Record<string, unknown> | undefined)?.content)
        if (isClaudeTaskNotification(o, text)) {
          // Claude Agent SDK 把后台 agent 完成通知写成新的 user message，并给它新的
          // promptId；它仍是当前真实用户轮次的 continuation。保留 cur，后续的
          // assistant/tool/hook 证据自然并入原轮，但通知本身不能成为 human prompt。
          suppressMetaAssistant = false
          continue
        }
        const injectedSkill = text ? injectedSkillName(text) : undefined
        if (o.isMeta === true && !injectedSkill) {
          cur = null
          suppressMetaAssistant = true
          continue
        }
        if (text && !injectedSkill) lineCtx.lastSkillName = undefined
        const userEvents = normalizeSdkMessage(o, lineCtx)
        if (injectedSkill && cur) {
          cur.items.push(...userEvents)
        } else if (text) {
          suppressMetaAssistant = false
          cur = {
            userText: text,
            ...(transcriptProviderTurnId(o) ? { providerTurnId: transcriptProviderTurnId(o) } : {}),
            items: []
          }
          if (pendingBeforeFirstTurn.length) {
            cur.items.push(...pendingBeforeFirstTurn)
            pendingBeforeFirstTurn = []
          }
          cur.items.push(...userEvents)
          turns.push(cur)
        } else if (cur) {
          cur.items.push(...userEvents)
        }
      } else if (o.type === 'system' || o.type === 'attachment') {
        const events = normalizeSdkMessage(o, lineCtx)
        if (events.length === 0) continue
        if (cur) cur.items.push(...events)
        else pendingBeforeFirstTurn.push(...events)
      } else if (o.type === 'assistant' && cur && !suppressMetaAssistant) {
        const msg = o.message as Record<string, unknown> | undefined
        cur.items.push(...normalizeSdkMessage(o, lineCtx))
        // The marker is copied verbatim; deciding what proves completion belongs to
        // the consumers that read native history, not to this parser.
        if (typeof msg?.stop_reason === 'string') cur.stopReason = msg.stop_reason
        const usageResult = transcriptUsageResult(msg, lineCtx)
        if (usageResult) {
          const usageKey = claudeTranscriptUsageKey({
            messageId: typeof msg?.id === 'string' ? msg.id : undefined,
            requestId: typeof o.requestId === 'string' ? o.requestId : undefined
          })
          if (!usageKey || !seenAssistantUsage.has(usageKey)) {
            if (usageKey) seenAssistantUsage.add(usageKey)
            cur.items.push(usageResult)
          }
        }
      }
    } finally {
      syncTranscriptContext(ctx, lineCtx)
    }
  }
  state.cur = cur
  state.pendingBeforeFirstTurn = pendingBeforeFirstTurn
  state.suppressMetaAssistant = suppressMetaAssistant
  return turns
}

// 把整个 transcript jsonl 解析成对话轮次（加载历史会话用）
export function parseTranscriptToTurns(content: string, ctx: NormalizeCtx): ParsedTurn[] {
  return appendTranscriptToTurns(content, ctx, createTranscriptParseState())
}
