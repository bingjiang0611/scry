import type { ProviderRunRequest, ProviderRunResult } from './types'
import type { PiAgentProfile } from '../pi-agent-profiles'
import type { TraceEvent } from '../../shared/trace'
import { classifyRunTermination } from '../../shared/runtime'
import { AgentRuntimeError } from '../run-outcome'
import { cancelManagedRecorderTurn } from '../../core/turn-recorder/managed'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { sanitizeProviderEnv } from '../claude-locate'
import type { HistoricalInput } from './historical-input'
import type { PiRunState } from './pi-types'
import { PiSessionProof, publishPersistedPiSession } from './pi-session-proof'
import { number, record } from './pi-shared'
import { piContinuationKey } from './pi-runtime'
import { piModelContextWindows } from './pi-catalog'
import { PiRpcCommandError, PiRecorderError, type PiRpcProcess, piEvent } from './pi-rpc'
import { piEntryBaseline, waitForPiUserEntryId } from './pi-entry-proof'
import { proveExplicitPiSkill, piExtensionCommand } from './pi-catalog'
import type { UsageAggregate } from './pi-usage'

export interface PiRunSuccessContext {
  profile: PiAgentProfile
  request: ProviderRunRequest
  state: PiRunState
  rpc: PiRpcProcess
  usage: UsageAggregate
  launchShellEnvError: string | undefined
  agentSettled: boolean
  env: Record<string, string>
  retainRpc: boolean
  emitUsageResult: (fields: Partial<Pick<TraceEvent, 'text' | 'isError' | 'terminationReason' | 'providerStopReason' | 'toolTermination'>>, partial?: boolean) => void
  modelContextWindows: Map<string, number>
  extensionCommand: string | undefined
  extensionCommandError: string | undefined
  historyReaderReady: boolean
  history: HistoricalInput
  startedAt: number
  toolTermination: TraceEvent['toolTermination']
  agentStarted: boolean
  toolNames: Map<string, string>
  settled: Promise<void>
  rpcFailure: Promise<never>
  mayReuse: boolean
}

export async function runPiAgentSuccess(ctx: PiRunSuccessContext): Promise<ProviderRunResult> {
    // Capability probes remain bounded; an explicitly started run stays cancellable while
    // large native history/extensions load, rather than being killed by a startup clock.
    const initialState = record((await ctx.rpc.send({ type: 'get_state' }, null)).data)
    if (typeof initialState.sessionId === 'string' && initialState.sessionId) {
      ctx.state.sessionId = initialState.sessionId
      ctx.state.sessionFile = typeof initialState.sessionFile === 'string' ? initialState.sessionFile : undefined
      ctx.history.verifySession(ctx.state.sessionId)
      publishPersistedPiSession(ctx.request, ctx.state)
    }
    ctx.request.emit(piEvent(ctx.request.runId, {
      kind: 'harness',
      stage: 'runtime:init',
      text: ctx.state.sessionId,
      runtimeMetadata: {
        agentProfileId: ctx.profile.id,
        executable: ctx.profile.executable,
        sessionId: initialState.sessionId ?? null,
        sessionFile: initialState.sessionFile ?? null,
        model: initialState.model ?? null,
        thinkingLevel: initialState.thinkingLevel ?? null
      }
    }))
    let modelChanged = false
    let activeModel = record(initialState.model)
    if (ctx.request.model) {
      if (!ctx.request.model.providerId) throw new Error('Pi 模型选择缺少 upstream providerId')
      const currentModel = record(initialState.model)
      modelChanged = currentModel.provider !== ctx.request.model.providerId || currentModel.id !== ctx.request.model.id
      // Even a same-model set performs auth lookup, appends a model-change entry and reapplies
      // native thinking defaults. Preserve that last effect when no explicit effort was selected.
      // Compare with this run's fresh state, not UI state or a previous pooled turn.
      if (modelChanged || !ctx.request.effort) {
        activeModel = record((await ctx.rpc.send({ type: 'set_model', provider: ctx.request.model.providerId, modelId: ctx.request.model.id })).data)
      }
    }
    const activeWindow = number(activeModel.contextWindow)
    if (activeWindow && activeWindow > 0) ctx.history.validateBudget(activeWindow)
    // A model switch may clamp/reset thinking; the pre-switch level is no longer authoritative.
    if (ctx.request.effort && (modelChanged || ctx.request.effort !== initialState.thinkingLevel)) {
      await ctx.rpc.send({ type: 'set_thinking_level', level: ctx.request.effort })
    }
    if (ctx.request.historyReader) {
      const command = `scry_history_ready_${ctx.request.historyReader.snapshotId.replaceAll('-', '')}`
      const commands = record((await ctx.rpc.send({ type: 'get_commands' })).data).commands
      // An unknown slash command could become a model prompt. Require the exact
      // run-scoped extension command before invoking this read-only control.
      if (!Array.isArray(commands) || !commands.some(item => record(item).name === command && record(item).source === 'extension')) {
        throw new Error('Pi 未注册本轮历史检索检查命令，输入未投递')
      }
      ctx.historyReaderReady = false
      await ctx.rpc.send({ type: 'prompt', message: `/${command}` })
      if (!ctx.historyReaderReady) throw new Error('Pi 模型选择后未确认历史检索工具可用，输入未投递')
    }
    // Model-window telemetry is optional. Do not put its native catalog latency in front of
    // entry baseline, recorder identity, or the prompt; the response can enrich context usage
    // while the turn is already running. The rejection is handled here so a delayed/failed
    // capability query cannot become an unhandled promise or change the run outcome.
    void ctx.rpc.send({ type: 'get_available_models' }).then((response) => {
      const available = record(response.data).models
      if (Array.isArray(available)) {
        for (const [key, value] of piModelContextWindows(available.map(record))) ctx.modelContextWindows.set(key, value)
      }
    }).catch(() => {
      // Model-window telemetry is optional; usage remains available without Context%.
    })
    const explicitSkillEvent = await proveExplicitPiSkill(ctx.rpc, ctx.request)
    ctx.extensionCommand = await piExtensionCommand(ctx.rpc, ctx.request.prompt)
    const entryBaseline = await piEntryBaseline(ctx.rpc)
    if (ctx.state.stopped) return { externalSessionId: ctx.state.persistedSessionId, stopped: true, status: 'interrupted' }
    if (ctx.request.managedRecorder) {
      if (!ctx.request.cwd || !ctx.state.sessionId || !ctx.request.managedRecorderIdentity) {
        throw new PiRecorderError('Pi managed recorder 缺少 workspace、session 或受信任轮次身份')
      }
      try {
        const opened = await handleRecorderHook({
          provider: 'pi',
          event: 'UserPromptSubmit',
          workspace: ctx.request.cwd,
          managed: true,
          env: {
            ...sanitizeProviderEnv(process.env as Record<string, string>, 'pi'),
            SCRY_MANAGED_RUN_ID: ctx.request.managedRecorderIdentity.runId,
            SCRY_MANAGED_PROMPT_HASH: ctx.request.managedRecorderIdentity.promptHash
          },
          payload: {
            session_id: ctx.state.sessionId,
            prompt: ctx.request.prompt,
            timestamp: new Date(ctx.startedAt).toISOString()
          }
        })
        if (opened.status !== 'started' && opened.status !== 'duplicate') {
          throw new Error(`无法建立轮次身份：${opened.reason ?? opened.status}`)
        }
      } catch (error) {
        throw new PiRecorderError(`Pi managed recorder 启动失败：${String((error as Error).message)}`, {
          cause: error
        })
      }
    }
    if (explicitSkillEvent) ctx.request.emit(explicitSkillEvent)
    const images = ctx.request.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }))
    const outgoingPrompt = ctx.history.text(ctx.request.prompt)
    const exactHandoff = ctx.history.snapshot() !== undefined || ctx.request.expectedContinuationKey !== undefined
    let persistedProof: PiSessionProof | undefined
    let promptDispatched = false
    try {
      if (ctx.state.stopped) throw new Error('Pi prompt 发送前已停止')
      // This is intentionally adjacent to the native RPC call. A receipt is an input
      // admission attempt, not proof that the process was merely initialized.
      if (ctx.request.expectedContinuationKey && await piContinuationKey(ctx.profile, ctx.request.cwd, ctx.env) !== ctx.request.expectedContinuationKey) {
        throw new Error('Pi 接续身份在输入前已变化；本次请求未发送')
      }
      if (exactHandoff) {
        if (!ctx.state.sessionId || !ctx.state.sessionFile) throw new Error('Pi native session 未提供可验证的 persisted session 文件')
        persistedProof = await PiSessionProof.capture(ctx.state.sessionFile, ctx.state.sessionId, outgoingPrompt, images.length)
      }
      if (ctx.state.stopped) return { stopped: true, status: 'interrupted' }
      ctx.history.attempting(outgoingPrompt)
      promptDispatched = true
      // Accepted execution stays owned until Pi acknowledges it or the user stops this process.
      await ctx.rpc.send({ type: 'prompt', message: outgoingPrompt, ...(images.length > 0 ? { images } : {}) }, null)
    } catch (error) {
      const identity = ctx.request.managedRecorderIdentity
      if (
        ctx.request.managedRecorder &&
        ctx.request.cwd &&
        ctx.state.sessionId &&
        identity &&
        (!promptDispatched || (error instanceof PiRpcCommandError && error.command === 'prompt'))
      ) {
        try {
          await cancelManagedRecorderTurn({
            workspace: ctx.request.cwd,
            provider: 'pi',
            sessionId: ctx.state.sessionId,
            runId: identity.runId,
            promptHash: identity.promptHash
          })
        } catch (cancelError) {
          throw new PiRecorderError('Pi prompt 未执行，但 provisional recorder lifecycle 撤销失败', {
            cause: new AggregateError([error, cancelError])
          })
        }
      }
      throw error
    }
    if (ctx.extensionCommand && !ctx.agentStarted && !ctx.state.stopped) {
      // Pi acknowledges an extension prompt only after its handler returns. A menu/settings
      // command need not append a user message or emit agent_settled. Do not wait for a model
      // boundary that has not been observed; this result proves the command handler only.
      const commandState = record((await ctx.rpc.send({ type: 'get_state' })).data)
      const response = await ctx.rpc.send({
        type: 'get_entries',
        ...(entryBaseline.appendCursor ? { since: entryBaseline.appendCursor } : {})
      })
      const entries = record(response.data).entries
      if (!Array.isArray(entries)) throw new Error('Pi RPC get_entries 返回了无效增量 entries')
      const hasModelEntry = entries.some((entry) => {
        const message = record(record(entry).message)
        return ['user', 'assistant', 'toolResult'].includes(String(message.role))
      })
      if (!ctx.agentStarted && !hasModelEntry && commandState.isStreaming === false &&
        commandState.isCompacting === false && commandState.pendingMessageCount === 0 &&
        commandState.sessionId === ctx.state.sessionId) {
        if (ctx.request.managedRecorder && ctx.request.cwd && ctx.state.sessionId && ctx.request.managedRecorderIdentity) {
          try {
            await cancelManagedRecorderTurn({
              workspace: ctx.request.cwd, provider: 'pi', sessionId: ctx.state.sessionId,
              runId: ctx.request.managedRecorderIdentity.runId,
              promptHash: ctx.request.managedRecorderIdentity.promptHash
            })
          } catch (error) {
            throw new PiRecorderError('Pi 命令已返回，但 provisional recorder lifecycle 撤销失败', { cause: error })
          }
        }
        ctx.request.emit(piEvent(ctx.request.runId, {
          kind: 'harness', stage: 'result', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: ctx.extensionCommandError ?? `/${ctx.extensionCommand} 命令交互已结束；未观测到模型轮次`,
          isError: ctx.extensionCommandError !== undefined,
          durationMs: Date.now() - ctx.startedAt,
          providerCommand: { name: ctx.extensionCommand, source: 'extension', modelTurn: 'unobserved' }
        }))
        publishPersistedPiSession(ctx.request, ctx.state)
        ctx.retainRpc = ctx.mayReuse && !ctx.state.stopped && !ctx.state.steerAdmissionUncertain && Boolean(ctx.state.persistedSessionId) && ctx.rpc.reusable()
        return {
          externalSessionId: ctx.state.persistedSessionId, stopped: ctx.state.stopped,
          status: ctx.state.stopped ? 'interrupted' : ctx.extensionCommandError === undefined ? 'completed' : 'failed'
        }
      }
    }
    const entryProof = await waitForPiUserEntryId(
      ctx.rpc,
      entryBaseline,
      () => ctx.agentSettled,
      () => ctx.state.steerDispatched === true,
      persistedProof
    )
    if (entryProof.status === 'verified') {
      ctx.state.providerTurnId = entryProof.entryId
      if (exactHandoff) ctx.history.accepted(ctx.state.sessionId!, 'pi_persisted_session_entry', entryProof.entryId)
    } else {
      // Native execution and Scry's receipt verification are separate evidence. Keep
      // the receipt unknown and let main's existing recording gate block canonical commit.
      ctx.state.recordingFailure = { message: entryProof.reason }
      ctx.history.unverified(entryProof.reason)
    }
    publishPersistedPiSession(ctx.request, ctx.state)
    // Pi workflows can intentionally run for hours. Do not impose a wall-clock or inactivity
    // deadline here: transport/process failures reject rpcFailure, and users retain stop controls.
    await Promise.race([ctx.settled, ctx.rpcFailure])
    // Startup supplies the native ID/path; persistence is checked independently. Asking Pi
    // for one more state snapshot after abort only delays the queued next turn and can hit
    // an avoidable timeout while the launcher is shutting down.
    let finalState = initialState
    if (!ctx.state.stopped) {
      try {
        finalState = record((await ctx.rpc.send({ type: 'get_state' })).data)
      } catch (error) {
        // The native turn has already settled. A metadata refresh timeout cannot rewrite that
        // outcome as a failed Agent run; retain startup identity and expose the evidence gap.
        ctx.request.emit(piEvent(ctx.request.runId, {
          kind: 'harness',
          stage: 'runtime:telemetry_degraded',
          text: `Pi final state unavailable: ${String((error as Error).message)}`,
          runtimeMetadata: { source: 'pi_rpc', capability: 'final_state' }
        }))
      }
    }
    if (typeof finalState.sessionId === 'string' && finalState.sessionId) {
      ctx.state.sessionId = finalState.sessionId
      ctx.state.sessionFile = typeof finalState.sessionFile === 'string' ? finalState.sessionFile : undefined
      publishPersistedPiSession(ctx.request, ctx.state)
    }
    const endedByTool = !ctx.state.stopped && ctx.usage.lastStopReason === 'toolUse' &&
      ctx.toolTermination !== undefined && ctx.toolNames.size === 0
    const unprovenToolBoundary = ctx.usage.lastStopReason === 'toolUse' && !endedByTool
    const stopReason = endedByTool ? ctx.toolTermination?.message : ctx.usage.lastError ?? ctx.usage.lastStopReason
    const failureText = unprovenToolBoundary
      ? 'Pi 在工具调用后结束，但缺少明确的工具终止证据；本轮结果未验证'
      : ctx.usage.lastError && ctx.usage.lastTransportError && ctx.usage.lastTransportError !== ctx.usage.lastError && !endedByTool
        ? `${ctx.usage.lastError} (${ctx.usage.lastTransportError})`
        : stopReason
    const terminationReason = endedByTool ? undefined : classifyRunTermination({ rawReason: ctx.usage.lastStopReason, message: failureText })
    // A settled Rotom RPC remains bound to this native session and retains its provider transport.
    // Reusing it makes Scry match terminal Pi instead of paying a fresh WebSocket/proxy handshake
    // and replaying the complete context on every user turn. An uncertain native steer may still
    // be queued in Pi's idle queue, so quarantine this transport rather than carry it forward.
    ctx.retainRpc = ctx.mayReuse && !ctx.state.stopped && !ctx.state.steerAdmissionUncertain && !ctx.state.recordingFailure && Boolean(ctx.state.persistedSessionId) && ctx.rpc.reusable()
    // Pi may settle cleanly at the RPC layer while the upstream model reports `aborted` (for
    // example Qoder aborting a long generation). Only an explicit Scry stop is an interruption;
    // an explicit tool termination is a separate execution boundary, not Goal approval.
    const failed = !ctx.state.stopped && !endedByTool && Boolean(ctx.usage.lastStopReason && ctx.usage.lastStopReason !== 'stop')
    ctx.emitUsageResult({
      text: failureText,
      isError: failed,
      ...(terminationReason ? { terminationReason } : {}),
      ...(ctx.usage.lastStopReason ? { providerStopReason: ctx.usage.lastStopReason } : {}),
      ...(endedByTool ? { toolTermination: ctx.toolTermination } : {})
    })
    if (failed) {
      const transportFailure = Boolean(
        ctx.usage.lastTransportError || ctx.usage.lastError?.toLowerCase().includes('fetch failed')
      )
      throw new AgentRuntimeError(failureText ?? 'Pi Provider 未正常完成本轮', {
        provider: 'pi_rpc',
        stage: 'runtime',
        cwd: ctx.request.cwd,
        nextAction: unprovenToolBoundary
          ? '先检查最后一项工具结果与 Rotom 日志，确认执行状态；不要在结果未知时重复执行'
          : terminationReason === 'input_context_overflow'
            ? '点击失败卡片的“从失败处恢复”，在新分支中移除或压缩大图后重试；也可以新建会话'
            : transportFailure
              ? ctx.launchShellEnvError ?? '检查上游服务和代理连接（WebSocket 与 SSE）；若修改了 shell 代理配置，请重启 Scry 后重试'
              : '继续当前会话重试；若再次中止，请检查上游 Provider 状态与 Rotom 日志'
      })
    }
    return {
      externalSessionId: ctx.state.persistedSessionId,
      providerTurnId: ctx.state.providerTurnId,
      stopped: ctx.state.stopped,
      status: ctx.state.stopped ? 'interrupted' : 'completed',
      ...(ctx.state.recordingFailure ? { recordingFailure: ctx.state.recordingFailure } : {})
    }
}
