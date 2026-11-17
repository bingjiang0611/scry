// 从 Provider transcript 的工具请求/结果配对中还原人工介入证据。
// 只认可观测到的结构：问题正文来自提问工具的入参，答案来自对应的 tool_result；
// 未观测到答案或取消的介入不生成，由调用方标 partial 并写明原因。

import type { AgentIntervention, AgentQuestionPrompt } from '../shared/runtime.js'
import type { TraceEvent } from '../shared/trace.js'
import { stringValue, type NormalizeCtx } from './normalize-core.js'

/** 提问工具的正文可能直接写进 message.content，配对时只看开始事件与结果事件。 */
const QUESTION_TOOL = 'AskUserQuestion'

const MAX_QUESTION_HEADER = 120
const MAX_QUESTION_TEXT = 2_000
const MAX_ANSWER_TEXT = 4_000

/** 介入字段的可信长度：超长内容裁断并保留省略号，不拒绝整条证据。 */
function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function questionPrompts(input: unknown): AgentQuestionPrompt[] | undefined {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  const questions = raw?.questions
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) return undefined
  const prompts: AgentQuestionPrompt[] = []
  for (const value of questions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const question = value as Record<string, unknown>
    const text = stringValue(question.question)
    const header = stringValue(question.header)
    if (!text || !header) return undefined
    const rawOptions = Array.isArray(question.options) ? question.options : []
    const options: AgentQuestionPrompt['options'] = []
    for (const option of rawOptions) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined
      const entry = option as Record<string, unknown>
      const label = stringValue(entry.label)
      const description = stringValue(entry.description)
      if (!label || !description) return undefined
      options.push({
        label,
        description,
        ...(stringValue(entry.preview) ? { preview: stringValue(entry.preview) } : {})
      })
    }
    prompts.push({
      question: bounded(text, MAX_QUESTION_TEXT),
      header: bounded(header, MAX_QUESTION_HEADER),
      options,
      multiSelect: question.multiSelect === true
    })
  }
  return prompts
}

function answersOf(outerResult: Record<string, unknown> | undefined, prompts: AgentQuestionPrompt[]): Record<string, string> | undefined {
  const answers = outerResult?.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined
  const record = answers as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const prompt of prompts) {
    const answer = record[prompt.question]
    if (typeof answer !== 'string' || !answer) return undefined
    result[prompt.question] = bounded(answer, MAX_ANSWER_TEXT)
  }
  return result
}

/**
 * 用户拒绝与宿主取消是两种事实，只能由 Provider 明确写出的拒绝类型或拒绝正文区分。
 * 普通的工具报错不满足任何一条，不生成介入。
 */
export function toolDenialResolution(
  outerResult: Record<string, unknown> | undefined,
  text: string
): 'user_cancelled' | 'provider_cancelled' | undefined {
  const kind = stringValue(outerResult?.toolDenialKind ?? outerResult?.tool_denial_kind)
  if (kind) {
    if (['interrupted', 'user_interrupted', 'user_rejected', 'user_denied'].includes(kind)) return 'user_cancelled'
    if (['host_cancelled', 'host_interrupted', 'policy_denied', 'denied_by_policy', 'provider_cancelled'].includes(kind)) return 'provider_cancelled'
  }
  if (/the user doesn'?t want to proceed|rejected by the user|interrupted by user|the user rejected/i.test(text)) return 'user_cancelled'
  if (/(permission|tool use|request)[^.]{0,40}(denied|cancelled) by (the )?(host|system|policy|provider)|host cancelled/i.test(text)) {
    return 'provider_cancelled'
  }
  return undefined
}

/** 被拦下的工具请求本身：只搬运工具名与它自己的目标，不编造对话框文案或选项。 */
function deniedRequestPrompt(started: TraceEvent): AgentQuestionPrompt {
  const input = started.input && typeof started.input === 'object' ? started.input as Record<string, unknown> : undefined
  const tool = started.tool ?? started.name ?? 'tool'
  const target = stringValue(input?.file_path ?? input?.path ?? input?.notebook_path) ?? stringValue(input?.command)
  return {
    header: bounded(tool, MAX_QUESTION_HEADER),
    question: bounded(target ? `${tool} ${target}` : tool, MAX_QUESTION_TEXT),
    options: [],
    multiSelect: false
  }
}

export interface TranscriptInterventionResult {
  intervention?: AgentIntervention
  /** 观测到提问、但没有观测到答案或取消：这条介入不能补，只能标 partial。 */
  gap?: string
}

export function transcriptIntervention(args: {
  ctx: NormalizeCtx
  started: TraceEvent | undefined
  toolUseId: string
  isError: boolean
  outerResult: Record<string, unknown> | undefined
  text: string
}): TranscriptInterventionResult {
  const { ctx, started, toolUseId, outerResult } = args
  if (!started) return {}
  const openedMs = Date.parse(started.ts)
  const closedMs = Date.parse(ctx.now())
  if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs) || closedMs < openedMs) return {}
  const openedAt = new Date(openedMs).toISOString()
  const closedAt = new Date(closedMs).toISOString()
  const durationMs = closedMs - openedMs
  const denial = toolDenialResolution(outerResult, args.text)

  if (started.tool === QUESTION_TOOL || started.name === QUESTION_TOOL) {
    const prompts = questionPrompts(started.input)
    if (!prompts) return { gap: 'a question was asked but its prompts could not be read, so no intervention was recorded' }
    const answers = answersOf(outerResult, prompts)
    const base = {
      source: 'provider_transcript_question',
      request: {
        runId: ctx.runId,
        questionId: toolUseId,
        ...(ctx.providerId ? { providerId: ctx.providerId } : {}),
        questionKind: 'clarification' as const,
        source: 'provider_transcript_question',
        questions: prompts
      },
      openedAt,
      closedAt,
      durationMs
    }
    if (answers) {
      return {
        intervention: {
          kind: 'clarification',
          ...base,
          resolution: 'answered',
          response: { runId: ctx.runId, questionId: toolUseId, behavior: 'answered', answers }
        }
      }
    }
    if (denial) {
      return {
        intervention: {
          kind: 'clarification',
          ...base,
          resolution: denial,
          response: { runId: ctx.runId, questionId: toolUseId, behavior: 'cancelled' }
        }
      }
    }
    return { gap: 'a question was asked but neither its answers nor a cancellation were observed' }
  }

  if (!args.isError || !denial) return {}
  return {
    intervention: {
      kind: 'permission',
      source: 'provider_transcript_tool_denial',
      resolution: denial,
      request: {
        runId: ctx.runId,
        questionId: toolUseId,
        ...(ctx.providerId ? { providerId: ctx.providerId } : {}),
        questionKind: 'permission',
        source: 'provider_transcript_tool_denial',
        questions: [deniedRequestPrompt(started)]
      },
      response: { runId: ctx.runId, questionId: toolUseId, behavior: 'cancelled' },
      openedAt,
      closedAt,
      durationMs
    }
  }
}
