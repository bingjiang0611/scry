/**
 * 命令收据：让带 `commandId` 的写命令可以安全重投。
 *
 * 场景是真实的：用户连按两次发送、renderer 在 reload 后重放待发请求、远端把一条
 * 命令重试一次。没有收据时第二条命令要么起第二轮，要么撞上「同一会话已在运行」的
 * 错误——而用户的意图其实已经执行过一次了，报错是误导。
 *
 * 语义刻意很窄：
 * - 只有调用方显式给出 `commandId` 才去重；没给就当成一条新命令执行。
 * - 第一条命令还在执行时，重复命令等待同一个 promise，不会并发执行两次。
 * - 命令失败后收据立即作废。失败是可以重试的，缓存失败会把重试永久变成「重复」。
 * - `sequence` 是本进程内单调递增的受理序号，用来判断两张收据谁先被受理。
 */

import { isCommandId } from '../shared/runtime.js'

export type CommandReceiptStatus = 'executed' | 'duplicate'

export interface CommandReceipt<T> {
  commandId?: string
  status: CommandReceiptStatus
  /** 首次受理该命令时分配的序号；重复命令返回原序号。 */
  sequence: number
  result: T
}

export class CommandInvariantError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandInvariantError'
    this.code = code
  }
}

export function assertCommandId(value: string): void {
  if (!isCommandId(value)) {
    throw new CommandInvariantError('invalid_command_id', 'commandId 必须是 8-128 个字符的 [A-Za-z0-9_:-]')
  }
}

interface Entry<T> {
  sequence: number
  pending: Promise<T>
  settled?: { result: T }
}

export class CommandReceipts<T> {
  readonly #entries = new Map<string, Entry<T>>()
  #sequence = 0

  constructor(private readonly limit = 256) {}

  /**
   * 执行命令或返回既有收据。
   * `commandId` 为 undefined 表示调用方不要求幂等，直接执行。
   */
  async submit(commandId: string | undefined, execute: () => Promise<T>): Promise<CommandReceipt<T>> {
    if (commandId === undefined) {
      const sequence = ++this.#sequence
      return { status: 'executed', sequence, result: await execute() }
    }
    assertCommandId(commandId)
    const existing = this.#entries.get(commandId)
    if (existing) {
      // 已完成的返回缓存结果；仍在执行的等待同一个 promise，不会执行第二次。
      const result = existing.settled ? existing.settled.result : await existing.pending
      return { commandId, status: 'duplicate', sequence: existing.sequence, result }
    }
    const sequence = ++this.#sequence
    const entry: Entry<T> = { sequence, pending: Promise.resolve() as Promise<T> }
    entry.pending = (async () => {
      try {
        const result = await execute()
        entry.settled = { result }
        return result
      } catch (error) {
        // 失败不构成收据：撤销登记，让调用方可以真正重试。
        this.#entries.delete(commandId)
        throw error
      }
    })()
    const pending = entry.pending
    this.#entries.set(commandId, entry)
    this.#evict()
    // pending 的拒绝由下面的 await 传播；这里先挂一个吞错处理器，
    // 避免重复命令还没到来时 Node 把它当成未处理拒绝。
    void pending.catch(() => undefined)
    return { commandId, status: 'executed', sequence, result: await pending }
  }

  /** 已登记的收据数量。诊断与测试用。 */
  size(): number {
    return this.#entries.size
  }

  #evict(): void {
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) return
      this.#entries.delete(oldest.value)
    }
  }
}
