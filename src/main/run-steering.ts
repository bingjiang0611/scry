import { createHash } from 'node:crypto'
import {
  normalizeAgentSteerRequest,
  type AgentInputAttachment,
  type AgentSteerInput,
  type AgentSteerResult
} from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'

type NativeSteer = (input: AgentSteerInput) => Promise<AgentSteerResult>

interface SteerAdmission {
  fingerprint: string
  promise: Promise<AgentSteerResult>
  result?: AgentSteerResult
  attempt: number
  preparedAttachments?: AgentInputAttachment[]
}

/** Each run owns admission identities; an uncertain write is never dispatched twice. */
export class RunSteering {
  private closed = false
  private readonly requests = new Map<string, SteerAdmission>()

  constructor(
    private readonly state: ActiveRun,
    private readonly nativeSteer: () => NativeSteer | undefined,
    private readonly prepareAttachments: (input: AgentSteerInput) => AgentInputAttachment[],
    private readonly emit: (event: TraceEvent) => void
  ) {}

  submit(input: AgentSteerInput): Promise<AgentSteerResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const previous = this.requests.get(input.messageId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.resolve({ status: 'rejected', message: 'Steer 消息身份对应的内容已变化，已拒绝发送。' })
      if (!previous.result || previous.result.status === 'accepted' || previous.result.status === 'unknown') return previous.promise
    }
    if (this.closed || this.state.done || this.state.providerSettled || this.state.stopState) {
      return Promise.resolve({ status: 'rejected', message: '当前任务已结束或正在停止，消息未作为 Steer 发送。' })
    }
    const capability = [...this.state.items].reverse().find(event => event.steerCapability)?.steerCapability
    const steer = this.nativeSteer()
    if (capability?.status !== 'available' || !steer) {
      return Promise.resolve({ status: 'unavailable', message: capability?.status === 'unavailable' ? capability.reason : '正在等待 Provider 的原生 Steer 能力。' })
    }
    if (input.attachments.length > 0 && !capability.attachments) {
      return Promise.resolve({ status: 'unavailable', message: '当前原生 Steer 不支持图片，消息与附件均未发送。' })
    }
    if ([...this.requests.values()].some(request => !request.result)) {
      return Promise.resolve({ status: 'rejected', message: '上一条 Steer 仍在等待回执，请稍后再试。' })
    }
    const attempt = (previous?.attempt ?? 0) + 1
    const entry: SteerAdmission = {
      fingerprint, attempt, preparedAttachments: previous?.preparedAttachments,
      // Defer execution so the identity is registered before the first trace/dispatch.
      promise: Promise.resolve().then(() => this.admit(input, steer, entry)).then(result => {
        entry.result = result
        return result
      })
    }
    this.requests.set(input.messageId, entry)
    return entry.promise
  }

  private async admit(input: AgentSteerInput, steer: NativeSteer, entry: SteerAdmission): Promise<AgentSteerResult> {
    // close/stop may have happened between IPC admission and the deferred dispatch.
    if (this.closed || this.state.done || this.state.providerSettled || this.state.stopState) {
      return { status: 'rejected', message: '发送前当前任务已结束或正在停止，消息未发送。' }
    }
    let attachments: AgentInputAttachment[]
    try {
      attachments = entry.preparedAttachments ?? this.prepareAttachments(input)
      entry.preparedAttachments = attachments
    } catch (error) {
      return { status: 'rejected', message: `Steer 附件未准备成功，消息未发送：${error instanceof Error ? error.message : String(error)}` }
    }
    const evidence = { ...input, attachments }
    this.emitEvidence(evidence, { status: 'pending' }, entry.attempt)
    let result: AgentSteerResult
    try {
      result = await steer(evidence)
    } catch (error) {
      // An exception after dispatch is not proof of non-delivery.
      result = { status: 'unknown', message: `Steer 接收结果未知，请先核对 Provider 回执：${error instanceof Error ? error.message : String(error)}` }
    }
    this.emitEvidence(evidence, result, entry.attempt)
    return result
  }

  private emitEvidence(input: AgentSteerInput, result: { status: 'pending' } | AgentSteerResult, attempt: number): void {
    this.emit({
      id: `steer-${input.messageId}-${attempt}-${result.status}`,
      ts: new Date().toISOString(),
      runId: this.state.runId,
      providerId: this.state.providerId,
      kind: 'human',
      stage: 'steer',
      steer: { ...input, ...result }
    })
  }

  close(): void { this.closed = true }

  /** Final archive/recorder evidence must include every in-flight admission outcome. */
  async idle(): Promise<void> {
    await Promise.all([...this.requests.values()].map(request => request.promise))
  }
}

/** Behind the production trusted IPC wrapper; no caller-supplied path or run rebinding. */
export async function steerObservedRun(payload: unknown, lookup: (runId: string) => {
  state: ActiveRun
  control: { steer: (input: AgentSteerInput) => Promise<AgentSteerResult> }
} | undefined): Promise<AgentSteerResult> {
  let request
  try { request = normalizeAgentSteerRequest(payload) } catch (error) {
    return { status: 'rejected', message: error instanceof Error ? error.message : String(error) }
  }
  const run = lookup(request.runId)
  if (!run || run.state.done || run.state.providerSettled || run.state.stopState ||
    run.state.providerId !== request.providerId || run.state.agentProfileId !== request.agentProfileId ||
    run.state.cwd !== request.cwd || run.state.externalSessionId !== request.expectedExternalSessionId) {
    return { status: 'rejected', message: 'Steer 的运行、Provider、目录或会话身份已变化，消息未发送。' }
  }
  return run.control.steer({ messageId: request.messageId, prompt: request.prompt, attachments: request.attachments })
}
