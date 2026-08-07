// 把 Claude Agent SDK 的 message stream（和 subagent transcript 行）归一化成统一 TraceEvent。
// 纯函数、不依赖 electron/SDK 运行时 —— 便于 vitest 单测（见 normalize.test.ts）。

import {
  type TraceEvent,
  type TraceKind,
  type ModelUsageRow,
  classifyTool,
  parseMcp,
  mcpPayloadFailed,
  fileOpOf
} from '../shared/trace.js'
import { classifyDanger } from './danger.js'

export interface NormalizeCtx {
  runId: string
  agentId?: string // 解析 subagent transcript 时带上
  cwd?: string // P3 审计：判跨项目写需要会话 cwd
  newId: () => string
  now: () => string
  latestContextTokens?: number // 最近一次 assistant usage 的完整 prompt；result.usage 可能是累计值，不能当当前上下文
  lastInferredSkill?: string // 从注入文本 / skill 文件路径推断的 skill；只用于压连续重复
  toolUseById?: Map<string, TraceEvent> // SDK tool_result 不重复携带工具身份时，用对应 tool_use 补全
}

// Anthropic content block（assistant message.content[] 里的元素）
interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

type BasePartial = Omit<Partial<TraceEvent>, 'id' | 'ts' | 'runId' | 'agentId'> & {
  kind: TraceKind
  stage: string
}

function base(ctx: NormalizeCtx, partial: BasePartial): TraceEvent {
  return { id: ctx.newId(), ts: ctx.now(), runId: ctx.runId, agentId: ctx.agentId, ...partial }
}

function contextTokensFromUsage(usage: unknown): number {
  const u = (usage as Record<string, number> | undefined) ?? {}
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

function usageNumber(usage: unknown, key: string): number | undefined {
  const value = (usage as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cacheCreationSplit(usage: unknown): { cacheCreation5mTokens?: number; cacheCreation1hTokens?: number } {
  const cache = (usage as Record<string, unknown> | undefined)?.cache_creation as Record<string, unknown> | undefined
  const fiveMin = cache?.ephemeral_5m_input_tokens
  const oneHour = cache?.ephemeral_1h_input_tokens
  return {
    cacheCreation5mTokens: typeof fiveMin === 'number' && Number.isFinite(fiveMin) ? fiveMin : undefined,
    cacheCreation1hTokens: typeof oneHour === 'number' && Number.isFinite(oneHour) ? oneHour : undefined
  }
}

function injectedSkillName(text: string): string | undefined {
  const m = text.match(/^Base directory for this skill:\s*(.+?)\s*$/m)
  if (!m) return undefined
  return cleanSkillPart(m[1].split('/').filter(Boolean).pop())
}

function cleanSkillPart(part: string | undefined): string | undefined {
  const s = part?.trim().replace(/[),;]+$/g, '')
  if (!s || s === '.' || s === '..') return undefined
  return s
}

function cleanPathPart(part: string): string {
  return part.trim().replace(/[),;]+$/g, '')
}

function skillNameFromSkillPath(path: string): string | undefined {
  const parts = path.split(/[\\/]+/).map(cleanPathPart).filter(Boolean)
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'skills') continue
    const name = cleanSkillPart(parts[i + 1])
    if (!name) continue
    const owner = parts[i - 1]
    const tail = parts.slice(i + 2)
    const knownSkillRoot = owner === '.claude' || owner === '.codex' || owner === '.agents'
    const readsSkillMd = tail.includes('SKILL.md')
    if (knownSkillRoot || readsSkillMd) return name
  }
  return undefined
}

function skillNamesFromTextPaths(text: string): string[] {
  const out = new Set<string>()
  const pathLike = /(?:^|[\s"'`=])([^\s"'`]*skills\/[^\s"'`]+(?:\/[^\s"'`]*)?)/g
  for (const m of text.matchAll(pathLike)) {
    const name = skillNameFromSkillPath(m[1])
    if (name) out.add(name)
  }
  return [...out]
}

function inferredSkillEvent(ctx: NormalizeCtx, name: string, input: Record<string, unknown>, messageId?: string): TraceEvent[] {
  const skill = cleanSkillPart(name)
  if (!skill) return []
  const key = skill.toLowerCase()
  if (ctx.lastInferredSkill === key) return []
  ctx.lastInferredSkill = key
  return [
    base(ctx, {
      kind: 'skill',
      stage: `skill:${skill}`,
      tool: 'Skill',
      name: skill,
      input,
      messageId
    })
  ]
}

function inferredSkillEventsForToolBlock(b: Block, ctx: NormalizeCtx, messageId?: string): TraceEvent[] {
  const input = b.input ?? {}
  if (b.name === 'Read' && typeof input.file_path === 'string') {
    const name = skillNameFromSkillPath(input.file_path)
    return name ? inferredSkillEvent(ctx, name, { source: 'skill_file', path: input.file_path }, messageId) : []
  }
  if (b.name === 'Bash' && typeof input.command === 'string') {
    return skillNamesFromTextPaths(input.command).flatMap((name) =>
      inferredSkillEvent(ctx, name, { source: 'skill_path_in_bash', command: input.command }, messageId)
    )
  }
  return []
}

function transcriptContextModel(model: unknown): { model?: string; contextWindow?: number } {
  if (typeof model !== 'string') return {}
  if (model === 'claude-opus-4-8' || model === 'claude-opus-4-8[1m]') {
    return { model: 'claude-opus-4-8[1m]', contextWindow: 1_000_000 }
  }
  return { model }
}

function transcriptUsageResult(msg: Record<string, unknown> | undefined, ctx: NormalizeCtx): TraceEvent | null {
  const usage = msg?.usage
  if (!usage || typeof usage !== 'object') return null
  const modelCtx = transcriptContextModel(msg?.model)
  const model = modelCtx.model ?? (typeof msg?.model === 'string' ? msg.model : 'unknown')
  const inputTokens = usageNumber(usage, 'input_tokens') ?? 0
  const outputTokens = usageNumber(usage, 'output_tokens') ?? 0
  const cacheReadTokens = usageNumber(usage, 'cache_read_input_tokens') ?? 0
  const cacheCreationTokens = usageNumber(usage, 'cache_creation_input_tokens') ?? 0
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return null
  const split = cacheCreationSplit(usage)
  const modelRow: ModelUsageRow = {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...split,
    contextWindow: modelCtx.contextWindow
  }
  return base(ctx, {
    kind: 'harness',
    stage: 'result',
    text: 'transcript assistant usage',
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...split,
    contextTokens: contextTokensFromUsage(usage) || undefined,
    modelUsage: [modelRow]
  })
}

function normalizeHookMessage(m: Record<string, unknown>, ctx: NormalizeCtx): TraceEvent[] {
  const subtype = typeof m.subtype === 'string' ? m.subtype : ''
  if ((subtype === 'local_command_output' || subtype === 'informational') && typeof m.content === 'string') {
    return [base(ctx, {
      kind: 'model',
      stage: 'text',
      text: m.content,
      runtimeMetadata: { source: 'provider_local_command', subtype }
    })]
  }
  if (subtype !== 'hook_started' && subtype !== 'hook_progress' && subtype !== 'hook_response') return []
  const hookName = typeof m.hook_name === 'string' ? m.hook_name : 'hook'
  const hookEvent = typeof m.hook_event === 'string' ? m.hook_event : 'Hook'
  const output = typeof m.output === 'string' ? m.output : undefined
  const stdout = typeof m.stdout === 'string' ? m.stdout : undefined
  const stderr = typeof m.stderr === 'string' ? m.stderr : undefined
  const command = typeof m.command === 'string' ? m.command : undefined
  const outcome = typeof m.outcome === 'string' ? m.outcome : subtype === 'hook_started' ? 'started' : 'progress'
  const exitCode = typeof m.exit_code === 'number' ? m.exit_code : undefined
  const durationMs = typeof m.duration_ms === 'number' && Number.isFinite(m.duration_ms) && m.duration_ms >= 0
    ? m.duration_ms
    : undefined
  return [
    base(ctx, {
      kind: 'hook',
      stage: subtype,
      tool: hookName,
      name: hookEvent,
      hookId: typeof m.hook_id === 'string' ? m.hook_id : undefined,
      hookName,
      hookEvent,
      hookCommand: command,
      hookOutcome: outcome,
      hookExitCode: exitCode,
      durationMs,
      text: output || stdout || stderr,
      output,
      input: {
        hookId: m.hook_id,
        hookName,
        hookEvent,
        command,
        outcome,
        exitCode,
        sessionId: m.session_id,
        stdout,
        stderr
      },
      isError: outcome !== 'cancelled' && (outcome === 'error' || (exitCode != null && exitCode !== 0))
    })
  ]
}

function textFromAttachmentContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((x) => String(x)).join('\n\n')
  return undefined
}

function normalizeHookAttachment(m: Record<string, unknown>, ctx: NormalizeCtx): TraceEvent[] {
  const a = m.attachment as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return []
  const type = typeof a.type === 'string' ? a.type : ''
  if (
    type !== 'hook_success' &&
    type !== 'hook_additional_context' &&
    type !== 'hook_cancelled' &&
    type !== 'async_hook_response'
  ) return []
  const hookName = typeof a.hookName === 'string' ? a.hookName : 'hook'
  const hookEvent = typeof a.hookEvent === 'string' ? a.hookEvent : hookName.split(':')[0] || 'Hook'
  const exitCode = typeof a.exitCode === 'number' ? a.exitCode : undefined
  const stdout = typeof a.stdout === 'string' ? a.stdout : undefined
  const stderr = typeof a.stderr === 'string' ? a.stderr : undefined
  const command = typeof a.command === 'string' ? a.command : undefined
  const timedOut = typeof a.timedOut === 'boolean' ? a.timedOut : undefined
  const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined
  const content = textFromAttachmentContent(a.content)
  const response = a.response && typeof a.response === 'object' ? a.response : undefined
  const outcome =
    type === 'hook_additional_context'
      ? 'progress'
      : type === 'hook_cancelled'
        ? 'cancelled'
        : exitCode != null && exitCode !== 0
          ? 'error'
          : 'success'
  const output = content || stdout || stderr || (type === 'hook_cancelled' ? 'hook cancelled' : undefined)
  return [
    base(ctx, {
      kind: 'hook',
      stage: type === 'hook_additional_context' ? 'hook_progress' : 'hook_response',
      tool: hookName,
      name: hookEvent,
      hookId: typeof a.toolUseID === 'string' ? a.toolUseID : undefined,
      hookName,
      hookEvent,
      hookCommand: command,
      hookOutcome: outcome,
      hookExitCode: exitCode,
      text: output,
      output,
      durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
      input: {
        hookId: a.toolUseID,
        hookName,
        hookEvent,
        outcome,
        exitCode,
        command,
        durationMs: a.durationMs,
        timedOut,
        timeoutMs,
        stdout,
        stderr,
        content,
        response
      },
      isError: outcome !== 'cancelled' && (outcome === 'error' || (exitCode != null && exitCode !== 0))
    })
  ]
}

// 一组 content block → TraceEvent[]（SDK 与 transcript 共用）。messageId = 该批 block 所属
// assistant message.id（llm_request 级，§7 两级；transcript 行无则不传）。
export function normalizeBlocks(
  blocks: Block[],
  parentToolUseId: string | null,
  ctx: NormalizeCtx,
  messageId?: string
): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      out.push(base(ctx, { kind: 'model', stage: 'text', text: b.text, parentToolUseId, messageId }))
    } else if (b.type === 'thinking' && b.thinking) {
      out.push(base(ctx, { kind: 'model', stage: 'thinking', thinking: b.thinking, parentToolUseId, messageId }))
    } else if (b.type === 'tool_use' && b.name) {
      out.push(...inferredSkillEventsForToolBlock(b, ctx, messageId))
      const cls = classifyTool(b.name, b.input)
      if (cls.kind === 'skill') ctx.lastInferredSkill = cls.name.toLowerCase()
      const mcp = parseMcp(b.name, b.input)
      const fo = fileOpOf(b.name, b.input)
      const danger = classifyDanger(b.name, b.input, ctx.cwd) // P3 审计：标记危险调用（不阻塞）
      const event = base(ctx, {
          kind: cls.kind,
          stage: `${cls.kind}:${cls.name}`,
          tool: b.name,
          name: cls.name,
          toolUseId: b.id,
          parentToolUseId,
          messageId,
          input: b.input,
          ...mcp,
          ...fo,
          ...(danger ? { danger } : {})
        })
      if (b.id) (ctx.toolUseById ??= new Map()).set(b.id, event)
      out.push(event)
    }
  }
  return out
}

// SDK message → TraceEvent[]
export function normalizeSdkMessage(msg: unknown, ctx: NormalizeCtx): TraceEvent[] {
  const m = msg as Record<string, unknown>
  if (!m || typeof m !== 'object') return []
  if (m.type === 'system') return normalizeHookMessage(m, ctx)
  if (m.type === 'attachment') return normalizeHookAttachment(m, ctx)
  if (m.type === 'assistant') {
    const msg = m.message as Record<string, unknown> | undefined
    const ctxTokens = contextTokensFromUsage(msg?.usage)
    if (ctxTokens > 0) ctx.latestContextTokens = ctxTokens
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
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') {
          const name = injectedSkillName(b.text)
          if (name) out.push(...inferredSkillEvent(ctx, name, { source: 'skill_injection' }))
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const toolUseId = String(b.tool_use_id)
          const started = ctx.toolUseById?.get(toolUseId)
          ctx.toolUseById?.delete(toolUseId)
          const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
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
                (started?.isMcp === true && mcpPayloadFailed(output))
            })
          )
        }
      }
      return out
    }
  }
  if (m.type === 'stream_event') {
    // C1：partial message —— 提取模型文本的 token 增量（其余 delta：thinking/工具入参 暂不流式）
    const e = m.event as Record<string, unknown> | undefined
    const delta = e?.delta as Record<string, unknown> | undefined
    if (e?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [base(ctx, { kind: 'model', stage: 'text_delta', text: delta.text })]
    }
    return []
  }
  if (m.type === 'result') {
    const u = (m.usage as Record<string, number> | undefined) ?? {}
    const resultText = typeof m.result === 'string' && m.result.trim() ? m.result : undefined
    const resultErrors = Array.isArray(m.errors)
      ? m.errors.filter((error): error is string => typeof error === 'string' && !!error.trim())
      : []
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
    const fallbackCtxTokens = contextTokensFromUsage(u)
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
        contextTokens: ctxTokens > 0 ? ctxTokens : undefined,
        durationMs: m.duration_ms as number | undefined,
        durationApiMs: m.duration_api_ms as number | undefined,
        modelUsage: hasMu ? modelUsage : undefined,
        isError: m.subtype !== 'success'
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

function outerToolResultFailure(message: Record<string, unknown>): { failed: boolean; toolUseId?: string } | undefined {
  let raw = message.toolUseResult ?? message.tool_use_result
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown } catch { return undefined }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result = raw as Record<string, unknown>
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
  ctx.lastInferredSkill = lineCtx.lastInferredSkill
  ctx.toolUseById = lineCtx.toolUseById
}

// 把整个 transcript jsonl 解析成对话轮次（加载历史会话用）
export function parseTranscriptToTurns(content: string, ctx: NormalizeCtx): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let cur: ParsedTurn | null = null
  let pendingBeforeFirstTurn: TraceEvent[] = []
  let suppressMetaAssistant = false
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
        if (text && !injectedSkill) lineCtx.lastInferredSkill = undefined
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
        const usageResult = transcriptUsageResult(msg, lineCtx)
        if (usageResult) cur.items.push(usageResult)
      }
    } finally {
      syncTranscriptContext(ctx, lineCtx)
    }
  }
  return turns
}
