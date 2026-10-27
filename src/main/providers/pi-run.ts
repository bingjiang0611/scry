import { lstat, realpath as realpathAsync } from 'node:fs/promises'
import type { ProviderRunRequest, ProviderRunResult } from './types'
import type { PiAgentProfile } from '../pi-agent-profiles'
import type { TraceEvent } from '../../shared/trace'
import { type AgentSteerResult } from '../../shared/runtime'
import { billingProviderForUpstream } from '../../shared/billing'
import { AgentRuntimeError } from '../run-outcome'
import { shellEnv, shellEnvError } from '../claude-locate'
import { HistoricalInput } from './historical-input'
import { PiBackgroundWork } from './pi-background-work'
import { PiQuestionnaire } from './pi-questionnaire'
import { type JsonRecord } from './pi-shared'
import { PI_BOOTSTRAP_MAX_BYTES, PI_HISTORY_EXTENSION_SHA256, PI_RPC_MAX_FRAME_BYTES, fileDigest, piContinuationKey, piRpcEnvironment, isRotomLauncher } from './pi-runtime'
import { PiRpcProcess, PiRpcCommandError, PiRecorderError, RotomRpcPool, piEvent } from './pi-rpc'
import type { PiRunState } from './pi-types'
import { attachPiEventHandlers } from './pi-run-events'
import { runPiAgentSuccess } from './pi-run-success'
import { piRpcArgs } from './pi-catalog'
import type { UsageAggregate } from './pi-usage'
import type { PiRunDiagnosticPhase } from './pi-run-diagnostics'

export async function runPiAgent(
  profile: PiAgentProfile,
  request: ProviderRunRequest,
  state: PiRunState,
  maxFrameBytes = PI_RPC_MAX_FRAME_BYTES,
  rotomPool?: RotomRpcPool,
  history = new HistoricalInput(request),
  historyExtensionPath?: string
): Promise<ProviderRunResult> {
  if (request.permissionMode !== 'full_access') {
    throw new AgentRuntimeError('Pi 只支持显式选择“本机完全访问”后运行', {
      provider: 'pi_rpc',
      stage: 'frontdoor',
      cwd: request.cwd,
      nextAction: '在权限选择器中选择“本机完全访问”；Pi 没有可映射的内置沙箱或审批模式'
    })
  }
  if (state.stopped) return { stopped: true, status: 'interrupted' }
  state.diagnostics?.record(request.runId, 'environment')
  const baseEnv = shellEnv()
  const launchShellEnvError = shellEnvError()
  const env = await piRpcEnvironment(profile, baseEnv)
  const continuationKey = request.expectedContinuationKey
    ? await piContinuationKey(profile, request.cwd, env) : undefined
  if (request.expectedContinuationKey && continuationKey !== request.expectedContinuationKey) {
    throw new Error('Pi 接续身份已变化，请重新预览')
  }
  // Stop may arrive while resolving the profile or probing Node. Do not spawn after that stop.
  if (state.stopped) return { stopped: true, status: 'interrupted' }
  const args = piRpcArgs({ session: request.resume })
  const launchEnv = { ...env }
  if (request.historyReader) {
    if (!historyExtensionPath) throw new Error('Pi 历史检索扩展不可用，输入未投递')
    const info = await lstat(historyExtensionPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > PI_BOOTSTRAP_MAX_BYTES ||
      await fileDigest(historyExtensionPath) !== PI_HISTORY_EXTENSION_SHA256) throw new Error('Pi 历史检索扩展身份不匹配，输入未投递')
    if (request.resume) await rotomPool?.invalidate({ providerId: 'pi', cwd: request.cwd, agentProfileId: profile.id, externalSessionId: request.resume })
    args.push('--extension', await realpathAsync(historyExtensionPath))
    launchEnv.SCRY_HISTORY_READER_URL = request.historyReader.url
    launchEnv.SCRY_HISTORY_READER_TOKEN = request.historyReader.token
    launchEnv.SCRY_HISTORY_READER_SNAPSHOT = request.historyReader.snapshotId
  }
  // A startup extension cannot refresh its authority for another run. Never pool it.
  const mayReuse = isRotomLauncher(profile) && !request.historyReader
  state.diagnostics?.record(request.runId, 'pool_lookup')
  const pooledRpc = mayReuse ? await rotomPool?.take(profile, request.cwd, request.resume, env, continuationKey) : undefined
  if (state.stopped) {
    await pooledRpc?.close()
    return { stopped: true, status: 'interrupted' }
  }
  const rpc = pooledRpc ?? PiRpcProcess.start(profile, args, launchEnv, request.cwd, maxFrameBytes)
  state.rpc = rpc
  let retainRpc = false
  let historyReaderReady = false
  const usage: UsageAggregate = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    allCostKnown: true,
    byModel: new Map()
  }
  const modelContextWindows = new Map<string, number>()
  const abortController = new AbortController()
  let stagedCustomAnswer: { value: string; inputTitle: string } | undefined
  const questionnaires = new Map<string, PiQuestionnaire>()
  const toolNames = new Map<string, string>()
  const toolStarts = new Map<string, number>()
  let streamedText = false
  let streamedThinking = false
  let assistantMessageSequence = 0
  let assistantMessageId: string | undefined
  let assistantFirstContentAtMs: number | undefined
  let assistantToolCallIds = new Set<string>()
  let toolTermination: TraceEvent['toolTermination']
  const nextAssistantMessageId = (message: JsonRecord): string => {
    const upstreamId = typeof message.id === 'string' && message.id.trim() ? message.id.trim() : undefined
    return upstreamId ? `pi:${upstreamId}` : `pi:${request.runId}:assistant-${++assistantMessageSequence}`
  }
  const currentAssistantMessageId = (message: JsonRecord = {}): string => {
    assistantMessageId ??= nextAssistantMessageId(message)
    return assistantMessageId
  }
  let agentStarted = false
  let extensionCommand: string | undefined
  let extensionCommandError: string | undefined
  let agentSettled = false
  let agentEnded = false
  /** The Provider reached native idle, so this run waits only for child evidence. */
  let nativeIdle = false
  let steerCapabilityEmitted = false
  let steerPending = false
  let resolveAgentCycleEnd!: () => void
  let agentCycleEnd = new Promise<void>(resolve => { resolveAgentCycleEnd = resolve })
  let settledResolve: (() => void) | undefined
  const settled = new Promise<void>((resolve) => { settledResolve = resolve })
  let rpcFailureReject: ((error: Error) => void) | undefined
  const rpcFailure = new Promise<never>((_resolve, reject) => { rpcFailureReject = reject })
  void rpcFailure.catch(() => undefined)
  const offFailure = rpc.onFailure((error) => rpcFailureReject?.(error))
  const background = new PiBackgroundWork()
  let diagnosticPhase: PiRunDiagnosticPhase = 'initial_state'
  let lastNativeLifecycle: 'agent_start' | 'agent_end' | 'agent_settled' | undefined
  let lastNativeLifecycleAt: string | undefined
  const diagnose = (phase = diagnosticPhase): void => {
    diagnosticPhase = phase
    state.diagnostics?.record(request.runId, phase, {
      rpcPid: rpc.child.pid, agentStarted, agentEnded, agentSettled, nativeIdle,
      backgroundPending: background.pending, stopRequested: state.stopped,
      lastNativeLifecycle, lastNativeLifecycleAt
    })
  }
  const emitBackground = (work: ReturnType<PiBackgroundWork['observe']>): void => {
    if (!work) return
    diagnose()
    request.emit(piEvent(request.runId, {
      kind: 'harness', stage: 'runtime:background_work', backgroundWork: work,
      runtimeMetadata: { source: 'pi_subagents_async_status_v1' }
    }))
  }
  const eventContext = {
    rpc,
    request,
    state,
    emitBackground,
    background,
    get agentEnded() { return agentEnded },
    set agentEnded(value: typeof agentEnded) { agentEnded = value },
    get agentSettled() { return agentSettled },
    set agentSettled(value: typeof agentSettled) { agentSettled = value },
    get agentCycleEnd() { return agentCycleEnd },
    set agentCycleEnd(value: typeof agentCycleEnd) { agentCycleEnd = value },
    get resolveAgentCycleEnd() { return resolveAgentCycleEnd },
    set resolveAgentCycleEnd(value: typeof resolveAgentCycleEnd) { resolveAgentCycleEnd = value },
    get settledResolve() { return settledResolve },
    set settledResolve(value: typeof settledResolve) { settledResolve = value },
    get nativeIdle() { return nativeIdle },
    set nativeIdle(value: typeof nativeIdle) { nativeIdle = value },
    get agentStarted() { return agentStarted },
    set agentStarted(value: typeof agentStarted) { agentStarted = value },
    get steerCapabilityEmitted() { return steerCapabilityEmitted },
    set steerCapabilityEmitted(value: typeof steerCapabilityEmitted) { steerCapabilityEmitted = value },
    get steerPending() { return steerPending },
    set steerPending(value: typeof steerPending) { steerPending = value },
    get streamedText() { return streamedText },
    set streamedText(value: typeof streamedText) { streamedText = value },
    get streamedThinking() { return streamedThinking },
    set streamedThinking(value: typeof streamedThinking) { streamedThinking = value },
    get assistantToolCallIds() { return assistantToolCallIds },
    set assistantToolCallIds(value: typeof assistantToolCallIds) { assistantToolCallIds = value },
    get toolTermination() { return toolTermination },
    set toolTermination(value: typeof toolTermination) { toolTermination = value },
    get assistantMessageId() { return assistantMessageId },
    set assistantMessageId(value: typeof assistantMessageId) { assistantMessageId = value },
    get assistantFirstContentAtMs() { return assistantFirstContentAtMs },
    set assistantFirstContentAtMs(value: typeof assistantFirstContentAtMs) { assistantFirstContentAtMs = value },
    get extensionCommand() { return extensionCommand },
    set extensionCommand(value: typeof extensionCommand) { extensionCommand = value },
    get extensionCommandError() { return extensionCommandError },
    set extensionCommandError(value: typeof extensionCommandError) { extensionCommandError = value },
    get historyReaderReady() { return historyReaderReady },
    set historyReaderReady(value: typeof historyReaderReady) { historyReaderReady = value },
    get stagedCustomAnswer() { return stagedCustomAnswer },
    set stagedCustomAnswer(value: typeof stagedCustomAnswer) { stagedCustomAnswer = value },
    nextAssistantMessageId,
    currentAssistantMessageId,
    usage,
    modelContextWindows,
    questionnaires,
    abortController,
    toolNames,
    toolStarts
  }
  const off = attachPiEventHandlers(eventContext)
  // Observe after canonical handlers so the snapshot includes their effective state.
  const offDiagnostic = rpc.onEvent(event => {
    if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'agent_settled') {
      lastNativeLifecycle = event.type
      lastNativeLifecycleAt = new Date().toISOString()
      diagnose()
    }
  })
  const uncertainSteer = (message: string): AgentSteerResult => {
    state.steerAdmissionUncertain = true
    return { status: 'unknown', message }
  }
  state.steer = async (input) => {
    if (state.stopped) return { status: 'rejected', message: 'Pi run 已停止，steer 未发送' }
    if (agentSettled || agentEnded) return { status: 'rejected', message: 'Pi agent 已结束，steer 未发送' }
    if (!agentStarted) return { status: 'unavailable', message: 'Pi agent 尚未进入 active run' }
    const images = input.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }))
    steerPending = true
    state.steerDispatched = true
    const cycleEnd = agentCycleEnd
    try {
      const outcome = await Promise.race([
        rpc.send({ type: 'steer', message: input.prompt, ...(images.length > 0 ? { images } : {}) })
          .then(() => 'ack' as const),
        cycleEnd.then(() => 'ended' as const)
      ])
      // Pi's RPC response has no turn guard. Once agent_end/settled wins the race, the
      // message may have been admitted to a future idle queue; never report it accepted.
      if (outcome === 'ended' || cycleEnd !== agentCycleEnd || agentEnded || agentSettled || state.stopped) {
        return uncertainSteer('Pi agent 在 steer 确认前结束，消息归属未知')
      }
      return { status: 'accepted', providerTurnId: state.providerTurnId }
    } catch (error) {
      if (cycleEnd !== agentCycleEnd || agentEnded || agentSettled || state.stopped) {
        return uncertainSteer('Pi agent 在 steer 确认前结束，消息归属未知')
      }
      if (error instanceof PiRpcCommandError) {
        return { status: 'rejected', message: `Pi steer 被 Provider 拒绝：${error.message}` }
      }
      // Timeout, process exit and stdin write failures do not prove whether Pi admitted it.
      return uncertainSteer(`Pi steer admission 未知：${(error as Error).message}`)
    } finally {
      steerPending = false
    }
  }
  const startedAt = Date.now()
  let resultEmitted = false
  const emitUsageResult = (fields: Partial<Pick<TraceEvent, 'text' | 'isError' | 'terminationReason' | 'providerStopReason' | 'toolTermination'>>, partial = false): void => {
    resultEmitted = true
    request.emit(piEvent(request.runId, {
      kind: 'harness', stage: 'result',
      tokensIn: usage.input, tokensOut: usage.output,
      cacheReadTokens: usage.cacheRead, cacheCreationTokens: usage.cacheWrite,
      reasoningTokens: usage.reasoning,
      contextTokens: usage.lastContextTokens, contextModel: usage.lastContextModel,
      contextProvider: usage.lastContextProvider,
      contextUsageSource: usage.contextUsageSource, contextUsageQuality: usage.contextUsageQuality,
      costUsd: usage.allCostKnown && usage.byModel.size > 0 ? usage.cost : undefined,
      costSource: usage.allCostKnown && usage.byModel.size > 0 ? 'price_table' : undefined,
      costConfidence: usage.allCostKnown && usage.byModel.size > 0 ? 'estimated' : undefined,
      costUnit: usage.allCostKnown && usage.byModel.size > 0 ? 'usd' : undefined,
      billingProvider: billingProviderForUpstream(usage.upstreamProvider),
      modelUsage: [...usage.byModel.values()], upstreamProvider: usage.upstreamProvider,
      usageSource: 'pi_rpc', durationMs: Date.now() - startedAt,
      runtimeMetadata: {
        agentProfileId: profile.id, sessionFile: state.sessionFile ?? null,
        model: usage.model ?? null, provider: usage.upstreamProvider ?? null,
        stderrTail: rpc.stderrTail() || null, transportError: usage.lastTransportError ?? null,
        shellEnvError: launchShellEnvError ?? null,
        ...(partial ? { usageCoverage: 'partial' } : {})
      },
      ...fields
    }))
  }
  try {
    return await runPiAgentSuccess({
      profile,
      request,
      state,
      rpc,
      diagnose,
      usage,
      get launchShellEnvError() { return launchShellEnvError },
      get agentSettled() { return agentSettled },
      env,
      get retainRpc() { return retainRpc },
      set retainRpc(value: boolean) { retainRpc = value },
      emitUsageResult,
      modelContextWindows,
      get extensionCommand() { return extensionCommand },
      set extensionCommand(value: string | undefined) { extensionCommand = value },
      get extensionCommandError() { return extensionCommandError },
      get historyReaderReady() { return historyReaderReady },
      set historyReaderReady(value: boolean) { historyReaderReady = value },
      history,
      startedAt,
      get toolTermination() { return toolTermination },
      get agentStarted() { return agentStarted },
      toolNames,
      settled,
      rpcFailure,
      mayReuse
    })
  } catch (error) {
    // Transport failure/stop can bypass agent_settled after completed requests
    // already supplied metering. Keep that observed lower bound, once, without
    // claiming a successful run or inventing unobserved in-flight usage.
    if (!resultEmitted && usage.byModel.size > 0) emitUsageResult({
      isError: !state.stopped, text: state.stopped ? 'Pi interrupted; observed usage only' : String((error as Error).message)
    }, true)
    if (state.stopped && !(error instanceof PiRecorderError)) return {
      externalSessionId: state.persistedSessionId,
      providerTurnId: state.providerTurnId,
      stopped: true,
      status: 'interrupted',
      ...(state.recordingFailure ? { recordingFailure: state.recordingFailure } : {})
    }
    if (error instanceof AgentRuntimeError) throw error
    const recorderFailure = error instanceof PiRecorderError
    throw new AgentRuntimeError(String((error as Error).message), {
      provider: 'pi_rpc',
      stage: recorderFailure ? 'ledger' : 'runtime',
      cwd: request.cwd,
      nextAction: recorderFailure
        ? '运行 scry doctor 检查工作区记录；升级 Recorder 后重试'
        : '检查该轮 Pi Provider 结果、launcher 与 stderr 后重试'
    })
  } finally {
    diagnose('rpc_cleanup')
    offDiagnostic()
    off()
    offFailure()
    emitBackground(background.end())
    abortController.abort()
    if (retainRpc && state.sessionId && rotomPool) rotomPool.keep(profile, request.cwd, state.sessionId, rpc, env, continuationKey)
    else await rpc.close()
    if (state.rpc === rpc) state.rpc = undefined
  }
}
