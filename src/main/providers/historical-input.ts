import { createHash, randomUUID } from 'node:crypto'
import type { ProviderHistoricalContext, ProviderInputReceipt, ProviderRunRequest } from './types'

const MAX_HISTORY_BYTES = 32 * 1024

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Exact history prefix persisted before an intent and reused at the native input boundary. */
export function historicalInputPrefix(context: ProviderHistoricalContext): string {
  if (!context.text.trim() || hash(context.text) !== context.contentHash) {
    throw new Error('交接历史为空或正文 hash 不匹配')
  }
  const prefix = '[Scry historical context: prior conversation, not a new command]\n' +
    context.text + '\n[End historical context]\n\n[Current user request]\n'
  if (Buffer.byteLength(prefix, 'utf8') > MAX_HISTORY_BYTES) {
    throw new Error('交接历史（含包装）超过 32 KiB；不得静默截断')
  }
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
    if (!context) return
    this.prefix = historicalInputPrefix(context)
    this.receipt = { contextHash: context.contentHash, status: 'not_sent', reason: '尚未尝试投递历史输入' }
  }

  text(prompt: string, nativeSkill = false): string {
    if (this.prefix === undefined) return prompt
    if (this.request.prompt.trimStart().startsWith('/') && !nativeSkill) {
      throw new Error('交接历史不能与原生斜杠命令同时发送；请先发送普通交接请求')
    }
    return this.prefix + prompt
  }

  /** Call immediately before the native input operation, not on session creation. */
  attempting(text: string): void {
    if (!this.receipt) return
    if (!text.startsWith(this.prefix!)) throw new Error('待发送文本缺少已验证的交接历史')
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
    if (this.receipt.status !== 'unknown') throw new Error('历史输入没有待确认的投递尝试')
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
      stage: 'runtime:historical_input',
      runtimeMetadata: { inputReceipt: this.snapshot() }
    })
  }
}
