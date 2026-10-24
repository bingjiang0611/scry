import type { RunTerminationEvidence, RunTerminationReason } from './runtime-types.js'

export function classifyRunTermination(evidence: RunTerminationEvidence): RunTerminationReason | undefined {
  const rawReason = typeof evidence.rawReason === 'string' ? evidence.rawReason.trim().toLowerCase() : ''
  const subtype = typeof evidence.subtype === 'string' ? evidence.subtype.trim().toLowerCase() : ''
  const message = typeof evidence.message === 'string' ? evidence.message.trim().toLowerCase() : ''
  const combined = [rawReason, subtype, message].filter(Boolean).join('\n')

  if (combined.includes('model_context_window_exceeded')) return 'model_context_window_exceeded'
  if (
    rawReason === 'max_tokens' ||
    rawReason === 'max_output_tokens' ||
    rawReason === 'length' ||
    /(?:finish_reason|stop_reason|incomplete_details)[^\n]*(?:length|max_(?:output_)?tokens)/.test(combined) ||
    /(?:response|output)[^\n]*(?:cut off|truncat|reached)[^\n]*(?:token|length)[^\n]*(?:limit|maximum)?/.test(combined) ||
    /(?:response|output)[^\n]*(?:token|length)[^\n]*(?:limit|maximum)[^\n]*(?:exceed|hit|reached)/.test(combined)
  ) return 'output_token_limit'
  if (subtype === 'error_max_turns' || /\bmax(?:imum)?[ _-]?turns?\b/.test(combined)) return 'max_turns'
  if (subtype === 'error_max_budget_usd' || /\b(?:max(?:imum)?[ _-]?)?budget(?:_usd)?\b[^\n]*(?:exceed|limit|reached)/.test(combined)) {
    return 'budget_exceeded'
  }
  if (
    /context_length_exceeded|context[ _-]?overflow/.test(combined) ||
    /\bhttp[_ -]?413\b|payload too large|request entity too large/.test(combined) ||
    /prompt[^\n]*(?:is )?too long/.test(combined) ||
    /input[^\n]*(?:too long|exceed)[^\n]*(?:context|token)/.test(combined) ||
    /(?:prompt|input)[^\n]*(?:context|token)[^\n]*(?:limit|maximum)[^\n]*(?:exceed|reached)/.test(combined) ||
    /maximum context length/.test(combined)
  ) return 'input_context_overflow'
  return undefined
}

export function runTerminationHint(reason: RunTerminationReason): string {
  if (reason === 'input_context_overflow') return '上下文超过模型窗口：精简或 compact 后重试，也可以新建会话'
  if (reason === 'output_token_limit') return '输出达到上限，结果可能不完整：继续生成，或要求更短的回答'
  if (reason === 'model_context_window_exceeded') return '输出耗尽模型上下文窗口，结果可能不完整：精简上下文后继续'
  if (reason === 'max_turns') return '已达到 Agent 最大轮数：继续当前会话，或缩小任务范围后重试'
  return '已达到本轮预算上限：调整预算或缩小任务范围后重试'
}

export function runTerminationLabel(reason: RunTerminationReason): string {
  if (reason === 'input_context_overflow') return '上下文已超限'
  if (reason === 'output_token_limit') return '输出已截断'
  if (reason === 'model_context_window_exceeded') return '上下文窗口已耗尽'
  if (reason === 'max_turns') return '已达最大轮数'
  return '已达预算上限'
}

export function isIncompleteRunTermination(reason: RunTerminationReason): boolean {
  return reason === 'output_token_limit' || reason === 'model_context_window_exceeded'
}
