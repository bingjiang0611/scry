import {
  normalizeAgentQuestionResponse,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '../shared/runtime'

export type UserQuestionChange =
  | { kind: 'open'; request: AgentQuestionRequest }
  | { kind: 'closed'; runId: string; questionId: string }

interface PendingQuestion {
  request: AgentQuestionRequest
  promise: Promise<AgentQuestionResponse>
  resolve: (response: AgentQuestionResponse) => void
  signal: AbortSignal
  onAbort: () => void
}

const questionKey = (runId: string, questionId: string): string => `${runId}\0${questionId}`

export class UserQuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(private readonly onChange: (change: UserQuestionChange) => void) {}

  request(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse> {
    if (signal.aborted) {
      return Promise.resolve({ runId: request.runId, questionId: request.questionId, behavior: 'cancelled' })
    }
    const key = questionKey(request.runId, request.questionId)
    const existing = this.pending.get(key)
    if (existing) {
      if (signal === existing.signal) return existing.promise
      if (signal.aborted) {
        return Promise.resolve({ runId: request.runId, questionId: request.questionId, behavior: 'cancelled' })
      }
      return new Promise<AgentQuestionResponse>((resolve) => {
        let settled = false
        const finish = (response: AgentQuestionResponse): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve(response)
        }
        const onAbort = (): void =>
          finish({ runId: request.runId, questionId: request.questionId, behavior: 'cancelled' })
        signal.addEventListener('abort', onAbort, { once: true })
        void existing.promise.then(finish)
      })
    }

    let resolve!: (response: AgentQuestionResponse) => void
    const promise = new Promise<AgentQuestionResponse>((done) => {
      resolve = done
    })
    const entry: PendingQuestion = {
      request,
      promise,
      resolve,
      signal,
      onAbort: () => this.settle(entry, { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' })
    }
    this.pending.set(key, entry)
    signal.addEventListener('abort', entry.onAbort, { once: true })
    this.notify({ kind: 'open', request })
    return promise
  }

  answer(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const raw = value as { runId?: unknown; questionId?: unknown }
    if (typeof raw.runId !== 'string' || typeof raw.questionId !== 'string') return false
    const entry = this.pending.get(questionKey(raw.runId, raw.questionId))
    if (!entry) return false
    const response = normalizeAgentQuestionResponse(entry.request, value)
    if (!response) return false
    this.settle(entry, response)
    return true
  }

  cancelRun(runId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.runId !== runId) continue
      this.settle(entry, { runId, questionId: entry.request.questionId, behavior: 'cancelled' })
    }
  }

  list(runId: string): AgentQuestionRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.request.runId === runId)
      .map((entry) => entry.request)
  }

  private settle(entry: PendingQuestion, response: AgentQuestionResponse): void {
    const key = questionKey(entry.request.runId, entry.request.questionId)
    if (this.pending.get(key) !== entry) return
    this.pending.delete(key)
    entry.signal.removeEventListener('abort', entry.onAbort)
    entry.resolve(response)
    this.notify({ kind: 'closed', runId: entry.request.runId, questionId: entry.request.questionId })
  }

  private notify(change: UserQuestionChange): void {
    try {
      this.onChange(change)
    } catch {
      // UI 通知失败不能让 SDK 的阻塞回调悬挂；pending 仍可通过 activeRun 恢复。
    }
  }
}
