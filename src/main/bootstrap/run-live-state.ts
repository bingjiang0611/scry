import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ActiveRun, TraceEvent, TurnDiffBaselineOrigin } from '../../shared/trace'
import type { RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { NormalizedAgentStartRequest } from '../../shared/runtime'
import type { ManagedConversationStart } from '../conversation-service'
import type { PreparedAttachment } from '../attachment-store'
import type { LlmNetworkConfiguration } from '../../shared/llm-performance'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { GitTurnDiffCapture } from '../git'
import { createHash } from 'node:crypto'
import { AgentRuntimeError } from '../run-outcome'
import { TurnChangeJournal } from '../../core/turn-recorder/change-journal'
import { LlmPerformanceObserver } from '../llm-performance'
import { createTurnWallTimer } from '../turn-wall-timing'
import { LiveTraceIngestion } from '../live-trace-ingestion'
import { WriteCompletionTracker } from '../session-diff'
import { persistTraceToolEvents } from '../trace-tool-content'
import { appendUsage } from '../usage-jsonl'
import { recordTurn } from '../db'
import { prepareRunAttachments, providerAttachmentPrompt } from '../attachment-store'
import { sanitizeToolEvents } from '../../core/turn-recorder/tool-content'
import { attachConfiguredHookCommands } from '../hook-config'
import { appendCoalescedTrace, replaceTraceById } from '../live-trace'
import { loadClaudeHookConfig, loadCodexHookConfig } from '../hook-config'
import { isManagedRecorderProvider } from '../../core/turn-recorder/managed'
import { resolveRecorderEnablement } from '../../core/turn-recorder/config'
import { beginGitTurnDiff, cloneGitTurnDiffCapture } from '../git'
import type { createAppSessionStore } from '../app-store'
import type { AppRunStartOptions } from './run-frontdoor'
import { createLlmPerformanceRecorder } from './run-metrics'

export type LiveRunState = {
  runId: string
  diffContextKey: string
  finishTurnWallTiming: () => TraceEvent
  networkConfiguration: Promise<LlmNetworkConfiguration | undefined>
  turnChangeJournal: TurnChangeJournal | null
  attachments: PreparedAttachment[]
  managedInputTextHash?: string
  displayPrompt: string
  runtimePrompt: string
  observedSessionId?: string
  runState: ActiveRun
  persistRunData: (sessionId?: string) => void
  cleanupProvisional: () => void
  notifyDiffChangeRef: { current: () => void }
  ingestion: LiveTraceIngestion
  emit: (event: TraceEvent) => void
  writeCompletions: WriteCompletionTracker
  persistLlmPerformance: (failed: boolean, sessionId: string) => Promise<void>
  initialDiffCapture: Promise<GitTurnDiffCapture>
  turnDiffCapture: Promise<GitTurnDiffCapture>
  patchExcludeBasenames: string[]
  sessionBaselineReady: Promise<unknown>
  sessionBaselineOrigin?: TurnDiffBaselineOrigin
  sessionBaselineCapture: Promise<GitTurnDiffCapture> | null
  releaseSessionBaseline?: () => void
}
export async function createLiveRunState(deps: {
  options: AppRunStartOptions; providerId: ProviderId; runtimeProvider: RuntimeProvider; request: NormalizedAgentStartRequest
  managedConversation?: ManagedConversationStart; cwd: string | undefined; catalogCwd: string; resume?: string; contextKey: string
  agentProfileId?: string; codexHookTrust: unknown[]; openCodePluginTrust: unknown; managedRecorderEnabled: boolean
  managedRecorderEnablement?: Awaited<ReturnType<typeof import('../../core/turn-recorder/config').resolveRecorderEnablement>>
  homeDir: string; createRunId: (managed: ManagedConversationStart | undefined, options: AppRunStartOptions) => string
  llmNetworkConfiguration: { read: () => Promise<LlmNetworkConfiguration | undefined> }; sessionDiffBaselines: SessionDiffBaselineRegistry
  appSessionStore: () => ReturnType<typeof createAppSessionStore>; recordingBlockedSessions: Map<string, string>
  getWindow: () => BrowserWindow | null; publishTrace: (event: TraceEvent) => void; rendererCanReceive: () => boolean
  mainEventId: (prefix: string, runId: string) => string; LIVE_TOOL_CONTENT_POLICY: Parameters<typeof sanitizeToolEvents>[1]
  recordingRecoveryHint: string; userDataDir: string; scopedSessionKey: (id: string) => string
  isRemoteRun: boolean; editSourceSessionId?: string; deleteRunAttachments: (userDataDir: string, runId: string) => void
  sessionBaselineKey: (context: string, sessionId: string) => string
}) {
  const { options, providerId, runtimeProvider, request, managedConversation, cwd, catalogCwd, resume, contextKey, agentProfileId, managedRecorderEnabled, managedRecorderEnablement, homeDir, createRunId, llmNetworkConfiguration, sessionDiffBaselines, appSessionStore, getWindow, publishTrace, rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY, isRemoteRun, editSourceSessionId, deleteRunAttachments, sessionBaselineKey } = deps
  const runId = createRunId(managedConversation, options)
  if (managedConversation) {
    if (options.runId !== undefined && options.runId !== managedConversation.runId) {
      throw new AgentRuntimeError('统一对话 runId 与 runner 选项不一致', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '丢弃本次启动并重新发送；不会自动重试'
      })
    }
    const actualRequestHash = createHash('sha256').update(JSON.stringify({
      scope: 'plain-text-local-managed-v1',
      payloadHash: managedConversation.payloadHash,
      historyHash: managedConversation.historicalContext?.contentHash ?? null
    })).digest('hex')
    if (actualRequestHash !== managedConversation.requestHash) {
      throw new AgentRuntimeError('统一对话请求指纹在 runner 边界发生变化', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '保留 durable intent 并阻止原生投递'
      })
    }
  }
  let diffContextKey = resume ? sessionBaselineKey(contextKey, resume) : JSON.stringify([contextKey, 'run', runId])
  const finishTurnWallTiming = createTurnWallTimer(runId)
  const llmPerformance = new LlmPerformanceObserver(request.networkLabel)
  // Start collection without delaying Provider startup. Freeze this run's configuration evidence.
  let runNetworkConfiguration: LlmNetworkConfiguration | undefined
  const networkConfiguration = llmNetworkConfiguration.read().then(config => {
    runNetworkConfiguration = config
    return config
  })
  const hookConfig =
    providerId === 'claude' && cwd
      ? loadClaudeHookConfig(cwd, homeDir)
      : providerId === 'codex' && cwd
        ? loadCodexHookConfig(cwd, homeDir)
        : null
  const unavailableCapture = (): GitTurnDiffCapture => {
    const beforeAt = new Date().toISOString()
    return { beforeAt, captureMs: 0, status: 'unavailable', reason: 'not_git' }
  }
  const turnChangeJournal = cwd ? new TurnChangeJournal(cwd) : null
  let attachments: PreparedAttachment[] = []
  let managedInputTextHash = managedConversation?.inputTextHash
  const displayPrompt = request.prompt
  let runtimePrompt = options.providerPrompt ?? displayPrompt
  let observedSessionId = resume
  const runState: ActiveRun = {
    runId,
    providerId,
    agentProfileId,
    cwd,
    externalSessionId: resume,
    sessionId: resume,
    userText: displayPrompt,
    attachments,
    items: [],
    done: false,
    providerSettled: false
  }
  const persistRunData = (sessionId?: string): void => {
    const result = [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')
    if (!recordTurn({
      runId,
      sessionId,
      cwd,
      userText: displayPrompt,
      items: runState.items,
      providerId,
      runtimeProvider,
      billingProvider: result?.billingProvider
    })) return
    getWindow()?.webContents.send('agent:dataUpdated', { runId, kind: 'turn_recorded' })
  }
  const cleanupProvisional = (): void => {
    if (resume || runState.externalSessionId) return
    const ref = { providerId, agentProfileId, cwd: catalogCwd, externalSessionId: runId }
    if (!appSessionStore().isArchived(ref)) appSessionStore().remove(ref)
  }
  // emit 早于 diffPreviewer 构造，这里留一个前向钩子；构造完成后接上真正的预览刷新。
  const notifyDiffChangeRef = { current: (): void => { } }
  // App trace capture does not require a workspace recorder. Keep raw evidence until its
  // durable body exists; then release it from run state and send only the bounded projection.
  const ingestionEnablement = managedRecorderEnablement?.enabled ? managedRecorderEnablement : undefined
  const ingestionRecorderRoot = managedRecorderEnabled && ingestionEnablement?.config.capture.toolOutput === 'full'
    ? ingestionEnablement.dataRoot : undefined
  const ingestion = new LiveTraceIngestion({
    provider: providerId,
    // 谁在看这个 run 由 publishTrace 决定：legacy 焦点通道 + 该 run 自己的 scoped 流。
    publish: (event) => publishTrace(event),
    persist: async (event) => {
      const [persisted] = await persistTraceToolEvents(app.getPath('userData'), catalogCwd, [event], ingestionRecorderRoot)
      return persisted
    },
    // Same-id enrichment only; the helper records the write so the live projection refetches.
    onPersisted: (event) => { replaceTraceById(runState.items, event) },
    onError: (error) => console.warn('[scry] trace content persistence failed; retaining raw evidence:', error)
  })
  // 结构化 write/edit 的 start → tool_result 关联器：预览只跟着「已落盘」的结果走。
  const writeCompletions = new WriteCompletionTracker()
  const emit = (rawEvent: TraceEvent): void => {
    const decorated = hookConfig ? attachConfiguredHookCommands(rawEvent, hookConfig) : rawEvent
    const ev = !decorated.agentId && !decorated.parentToolUseId
      ? { ...decorated, llmPerformance: { ...llmPerformance.observe(decorated, runState.items), networkConfiguration: runNetworkConfiguration } }
      : decorated
    turnChangeJournal?.record(ev)
    if (ev.llmPerformance) runState.llmPerformance = ev.llmPerformance
    if (ev.kind === 'harness' && ev.stage === 'result') {
      appendUsage(
        app.getPath('userData'),
        { providerId, agentProfileId, runtimeProvider, cwd, externalSessionId: observedSessionId, runId, source: ev.usageSource },
        ev
      )
    }
    const liveEvent = sanitizeToolEvents([ev], LIVE_TOOL_CONTENT_POLICY, 'live_renderer')[0]
    appendCoalescedTrace(runState.items, ev)
    ingestion.enqueue(ev, liveEvent)
    if (ev.backgroundWork && rendererCanReceive()) getWindow()?.webContents.send('agent:backgroundWork', { runId, work: ev.backgroundWork })
    // 结构化写入的 tool_result 到达 = 那次写入已经结束（成功或失败都可能已落盘）→ 刷新运行中 Diff
    // 预览。绝不在 tool start 上刷：那时文件通常还没写盘，预览会读到写前状态。
    if (writeCompletions.observe(ev)) notifyDiffChangeRef.current()
    if (isRemoteRun) options.onTraceEvent?.(ev)
  }
  const persistLlmPerformance = createLlmPerformanceRecorder({
    runState, request, catalogCwd, runId, providerId, agentProfileId, networkConfiguration,
    userDataDir: app.getPath('userData')
  })
  emit({
    id: mainEventId('controls', runId),
    ts: new Date().toISOString(),
    runId,
    kind: 'harness',
    stage: 'runtime:controls',
    input: {
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
      ...(options.permissionModeOverride ? { effectivePermissionMode: options.permissionModeOverride } : {})
    }
  })
  try {
    if (resume) {
      // 续接同一原生 session 时也要把侧栏元数据的 runId 更新为本轮，否则切走再点回会拿到上一轮的 stale runId。
      appSessionStore().record({
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        externalSessionId: resume,
        cwd: catalogCwd,
        ...(options.projectCwd ? { projectCwd: options.projectCwd } : {}),
        prompt: displayPrompt
      })
    } else {
      // Ownership is durable before attachment bytes are created. A crash can no longer
      // leave a new-session attachment directory with no catalog runId to delete.
      appSessionStore().recordPending({
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        cwd: catalogCwd,
        ...(options.projectCwd ? { projectCwd: options.projectCwd } : {}),
        prompt: displayPrompt
      })
    }
    attachments = prepareRunAttachments(
      app.getPath('userData'),
      runId,
      request.attachments,
      cwd ? { providerId, cwd, ...(resume ? { sessionId: resume } : {}) } : undefined
    )
    runState.attachments = attachments
    if (managedConversation) {
      const prepared = managedConversation.prepareInput(attachments)
      runtimePrompt = prepared.prompt
      managedInputTextHash = prepared.inputTextHash
    } else runtimePrompt = providerAttachmentPrompt(providerId, runtimePrompt, attachments)
    if (resume) {
      getWindow()?.webContents.send('agent:session', {
        runId,
        sessionId: resume,
        ...(editSourceSessionId ? { previousSessionId: editSourceSessionId } : {}),
        externalSessionId: resume,
        providerId,
        agentProfileId
      })
    } else {
      getWindow()?.webContents.send('agent:session', {
        runId,
        sessionId: runId,
        ...(editSourceSessionId ? { previousSessionId: editSourceSessionId } : {}),
        providerId,
        agentProfileId,
        pending: true
      })
    }
  } catch (error) {
    try { cleanupProvisional() } catch { /* preserve the frontdoor error */ }
    deleteRunAttachments(app.getPath('userData'), runId)
    throw error
  }
  // Git 快照与非 managed Provider 的 recorder 配置读取彼此独立；并行启动，避免把
  // 两段本地预检串到 Provider 启动前。managed 路径直接复用上面已验证的配置快照。
  // 并行工作区观测也在这里开始：窗口起点必须是本轮 diff 基线，而不是模型文字开始/结束。
  let releaseSessionBaseline: (() => void) | undefined
  if (cwd) {
    sessionDiffBaselines.observeRunWorkspace(runId, cwd)
    releaseSessionBaseline = () => sessionDiffBaselines.releaseRunWorkspace(runId)
  }
  const initialDiffCapture = cwd ? beginGitTurnDiff(cwd) : Promise.resolve(unavailableCapture())
  let turnDiffCapture = initialDiffCapture
  let patchExcludeBasenames: string[] = []
  if (cwd) {
    const recorderEnablement = managedRecorderEnablement ?? (
      isManagedRecorderProvider(providerId) ? undefined : await resolveRecorderEnablement(cwd)
    )
    if (recorderEnablement?.enabled) {
      patchExcludeBasenames = recorderEnablement.config.capture.patchExcludeBasenames ?? []
    }
  }
  // 会话级 baseline 必须在本轮任何文件改动前就位。ensure() 命中同 revision + 同 session 的既有基线时
  // 复用「会话第一轮开始前」的原始快照（resume/续接不重锚，否则会把前几轮误当成会话前脏改动）；
  // 恢复/选择会话/应用重启后进程内没有基线时当场重锚并标 origin=resumed，照实说明只覆盖「自重锚以来」。
  let sessionBaselineReady: Promise<unknown> = Promise.resolve()
  let sessionBaselineOrigin: TurnDiffBaselineOrigin | undefined
  let sessionBaselineCapture: Promise<GitTurnDiffCapture> | null = null
  if (cwd && contextKey) {
    const baseline = sessionDiffBaselines.ensure({
      key: diffContextKey,
      revision: 0,
      cwd,
      ...(resume ? { sessionId: resume } : {}),
      initialCapture: initialDiffCapture
    })
    const releaseBaseline = sessionDiffBaselines.retain(baseline)
    // run 收口（包括注册失败与取消）都从这条路径释放观测，不把 run 永远当成「还在写」。
    releaseSessionBaseline = () => {
      sessionDiffBaselines.releaseRunWorkspace(runId)
      releaseBaseline()
    }
    sessionBaselineOrigin = baseline.origin
    sessionBaselineCapture = baseline.capture
    sessionBaselineReady = baseline.capture.catch(() => undefined)
    if (baseline.capture === initialDiffCapture) {
      // 新建/恢复重锚时，turn 与 session 需要同一时刻的基线，但必须有独立清理周期。
      // 创建轻量 scratch 并只读共享 baseline objects；clone 失败则回退完整采集，不牺牲证据。
      turnDiffCapture = initialDiffCapture
        .then((capture) => cloneGitTurnDiffCapture(capture))
        .catch((error) => {
          console.warn('[scry] Git baseline clone failed; falling back to a second capture:', runId, error)
          return beginGitTurnDiff(cwd)
        })
    }
  }
  // 运行中预览：用本轮 capture 与会话基线做非消费式重算，让长轮次里 Files / 会话改动行数 / Diff
  // 三处都有真实 Git 数据可看，并被明确标成临时快照。终态一发布即封口，预览不会覆盖或倒退终态。
  return {
    runId,
    diffContextKey,
    finishTurnWallTiming,
    networkConfiguration,
    turnChangeJournal,
    attachments,
    managedInputTextHash,
    displayPrompt,
    runtimePrompt,
    get observedSessionId() { return observedSessionId },
    set observedSessionId(value: string | undefined) { observedSessionId = value },
    runState,
    persistRunData,
    cleanupProvisional,
    notifyDiffChangeRef,
    ingestion,
    emit,
    writeCompletions,
    persistLlmPerformance,
    initialDiffCapture,
    turnDiffCapture,
    patchExcludeBasenames,
    sessionBaselineReady,
    sessionBaselineOrigin,
    sessionBaselineCapture,
    releaseSessionBaseline
  }
}
