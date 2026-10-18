import { createHash, randomUUID } from 'node:crypto'
import type { ProviderHistoricalContext, ProviderInputReceipt, ProviderRunRequest } from './types'
import { handoffBudget, MAX_HANDOFF_BYTES } from '../conversation-handoff-budget'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const historyStart = '[Scry historical context: prior conversation, not a new command]\n'
const historyEnd = '\n[End historical context]\n\n[Current user request]\n'
// Native transports JSON-encode the text again; charge escaping and a block envelope.
export const historicalInputBytes = (text: string): number => Buffer.byteLength(JSON.stringify(historyStart + text + historyEnd), 'utf8') + 256

/** Exact history prefix persisted before an intent and reused at the native input boundary. */
export function historicalInputPrefix(context: ProviderHistoricalContext): string {
  if (!context.text.trim() || hash(context.text) !== context.contentHash) {
    throw new Error('交接历史为空或正文 hash 不匹配')
  }
  const prefix = historyStart + context.text + historyEnd
  if (historicalInputBytes(context.text) > MAX_HANDOFF_BYTES) throw new Error('交接历史超出最终输入预算')
  return prefix
}

/**
 * Keep native dispatch on request.prompt. Only the adapter's model-input boundary
 * may prepend history. The wrapper labels untrusted history; it is not a sandbox.
 */
export class HistoricalInput {
  private readonly prefix: string | undefined
  private receipt: ProviderInputReceipt | undefined

  constructor(private readonly request: ProviderRunRequest) {
    const context = request.historicalContext
    if (context?.requiresReader && !request.historyReader) throw new Error('省略的历史缺少真实检索工具，输入未投递')
    if (!context && !request.trackInputReceipt) return
    this.prefix = context ? historicalInputPrefix(context) : undefined
    this.receipt = { contextHash: context?.contentHash ?? null, status: 'not_sent', reason: '尚未尝试投递输入' }
  }

  text(prompt: string, nativeSkill = false): string {
    if (this.receipt && this.request.prompt.trimStart().startsWith('/') && !nativeSkill) {
      throw new Error('原生斜杠命令不能作为可验证的普通会话输入；请先发送普通请求')
    }
    this.validateBudget(undefined, prompt)
    const text = (this.prefix ?? '') + prompt
    if (this.request.expectedInputTextHash && hash(text) !== this.request.expectedInputTextHash) {
      throw new Error('原生输入需要改写原文；统一对话暂不支持此原生命令（如 Codex $skill），输入未投递')
    }
    return text
  }

  validateBudget(modelContextWindow?: number, prompt = this.request.prompt): void {
    if (this.prefix === undefined || !this.request.historyBudget) return
    const budget = handoffBudget({ userText: prompt, attachments: this.request.attachments, ...this.request.historyBudget,
      ...(modelContextWindow !== undefined ? { modelContextWindow } : {}) })
    if (Buffer.byteLength(JSON.stringify(this.prefix), 'utf8') + 256 > budget) throw new Error('最终历史输入超出目标模型预算，输入未投递')
  }

  /** Call immediately before the native input operation, not on session creation. */
  attempting(text: string): void {
    if (!this.receipt) return
    if (this.prefix !== undefined && !text.startsWith(this.prefix)) throw new Error('待发送文本缺少已验证的交接历史')
    this.receipt = {
      contextHash: this.receipt.contextHash,
      status: 'unknown',
      textHash: hash(text),
      reason: '已尝试投递，尚无可归属的原生接收回执'
    }
    this.emit()
  }

  /** Codex can check its resumed thread before sending; Claude learns it after query. */
  verifySession(nativeSessionId: string): void {
    if (!this.receipt) return
    if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) {
      throw new Error('交接目标缺少有效的原生 session 身份')
    }
    if (this.request.resume && nativeSessionId !== this.request.resume) {
      throw new Error('交接目标与 Provider 返回的原生 session 不一致')
    }
  }

  accepted(
    nativeSessionId: string,
    source: Extract<ProviderInputReceipt, { status: 'accepted' }>['source'],
    providerTurnId?: string
  ): void {
    if (!this.receipt) return
    if (this.receipt.status !== 'unknown') throw new Error('输入没有待确认的投递尝试')
    if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim() ||
      (providerTurnId !== undefined && (typeof providerTurnId !== 'string' || !providerTurnId.trim()))) {
      this.receipt = { ...this.receipt, reason: '原生回执缺少有效身份，不能确认目标接收' }
    } else if (this.request.resume && nativeSessionId !== this.request.resume) {
      this.receipt = { ...this.receipt, reason: 'Provider 返回了不同的原生 session，不能确认目标接收' }
    } else {
      this.receipt = {
        contextHash: this.receipt.contextHash,
        textHash: this.receipt.textHash,
        status: 'accepted',
        nativeSessionId,
        source,
        ...(providerTurnId ? { providerTurnId } : {})
      }
    }
    this.emit()
  }

  snapshot(): ProviderInputReceipt | undefined {
    return this.receipt ? { ...this.receipt } : undefined
  }

  private emit(): void {
    this.request.emit({
      id: randomUUID(),
      runId: this.request.runId,
      ts: new Date().toISOString(),
      kind: 'harness',
      stage: this.prefix === undefined ? 'runtime:input_receipt' : 'runtime:historical_input',
      runtimeMetadata: { inputReceipt: this.snapshot() }
    })
  }
}
