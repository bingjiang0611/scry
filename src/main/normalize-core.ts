// Pure Claude Agent SDK / transcript primitives shared by the normalization modules.
// No electron/SDK runtime dependency: unit tests import these directly.

import type { ModelUsageRow, TraceEvent, TraceKind } from '../shared/trace.js'
import { classifyTool, fileOpOf, parseMcp } from '../shared/trace.js'
import { classifyDanger } from './danger.js'

export interface NormalizeCtx {
  runId: string
  agentId?: string // 解析 subagent transcript 时带上
  cwd?: string // P3 审计：判跨项目写需要会话 cwd
  newId: () => string
  now: () => string
  latestContextTokens?: number // 最近一次 assistant usage 的完整 prompt；result.usage 可能是累计值，不能当当前上下文
  latestContextModel?: string // contextTokens 的模型身份；多模型 usage 不能按 modelUsage 顺序猜窗口
  contextTokensFromUsage?: (usage: unknown) => number // Provider-specific cache 口径；缺省为 Anthropic 分项相加
  lastSkillName?: string // Skill 注入与原生 Skill 调用去重；路径引用不参与
  toolUseById?: Map<string, TraceEvent> // SDK tool_result 不重复携带工具身份时，用对应 tool_use 补全
  agentToolUseIds?: Set<string> // task_* 只回指已观测的 Agent tool_use，不把其他后台任务混进来
  agentTaskToolUseById?: Map<string, string> // 仅保留由 Agent tool_use 建立的 task_id 别名
  streamMessageIds?: Map<string, string>
}

// Anthropic content block（assistant message.content[] 里的元素）
export interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type BasePartial = Omit<Partial<TraceEvent>, 'id' | 'ts' | 'runId' | 'agentId'> & {
  kind: TraceKind
  stage: string
}

export function base(ctx: NormalizeCtx, partial: BasePartial): TraceEvent {
  return { id: ctx.newId(), ts: ctx.now(), runId: ctx.runId, agentId: ctx.agentId, ...partial }
}

export function contextTokensFromUsage(usage: unknown): number {
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

export function injectedSkillName(text: string): string | undefined {
  const m = text.match(/^Base directory for this skill:\s*(.+?)\s*$/m)
  if (!m) return undefined
  return cleanSkillPart(m[1].split('/').filter(Boolean).pop())
}

export function cleanSkillPart(part: string | undefined): string | undefined {
  const s = part?.trim().replace(/[),;]+$/g, '')
  if (!s || s === '.' || s === '..') return undefined
  return s
}

export function skillInjectionEvent(ctx: NormalizeCtx, name: string, input: Record<string, unknown>, messageId?: string): TraceEvent[] {
  const skill = cleanSkillPart(name)
  if (!skill) return []
  const key = skill.toLowerCase()
  if (ctx.lastSkillName === key) return []
  ctx.lastSkillName = key
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

export function transcriptUsageResult(msg: Record<string, unknown> | undefined, ctx: NormalizeCtx): TraceEvent | null {
  const usage = msg?.usage
  if (!usage || typeof usage !== 'object') return null
  const model = typeof msg?.model === 'string' ? msg.model : 'unknown'
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
    ...split
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
    contextModel: model,
    contextUsageSource: 'provider_transcript',
    contextUsageQuality: 'exact',
    modelUsage: [modelRow]
  })
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
      // 路径读取与命令参数不证明 Skill 执行；只接受 Provider 明确声明的 Skill 调用。
      const cls = classifyTool(b.name, b.input)
      if (cls.kind === 'skill') ctx.lastSkillName = cls.name.toLowerCase()
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
      if (b.id) {
        (ctx.toolUseById ??= new Map()).set(b.id, event)
        if (cls.kind === 'agent') (ctx.agentToolUseIds ??= new Set()).add(b.id)
      }
      out.push(event)
    }
  }
  return out
}
