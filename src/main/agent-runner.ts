// 模式 A：用 Claude Agent SDK 驱动 claude，把 message stream 归一化成 TraceEvent 流式 emit。
// 支持多轮对话（resume）+ 工作目录（cwd）+ 中断（interrupt）+ subagent 内部明细（tail transcript 一层）。

import { HISTORY_READER_SERVER, HISTORY_READER_TOOL, type HistoryReaderConnection } from './conversation-history-reader'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { type TraceEvent, type McpLiveStatus } from '../shared/trace'
import { WORKFLOW_MAX_VALUE_BYTES, type WorkflowLiveObservation } from '../shared/workflow'
import { workflowAuthoringCopy } from '../shared/constants/copy'
import type { ProviderStructuredOutput } from './providers/types'
import {
  type AgentInputAttachment,
  type AgentPermissionMode,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '../shared/runtime'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'
import { sanitizeMcpAuthError } from './providers/mcp-auth-security'
import { captureProcessIdentity, signalProcessTreeWithIdentity, type ProcessIdentity } from './process-diagnostics'
import { createAgentOptions } from './agent-runner-options'
import {
  hookString,
  isSyntheticPromptHook,
  nativeProviderTurnId,
  providerTurnIdFromTranscript,
  transcriptBaseline,
  type TranscriptBaseline
} from './agent-runner-transcript'
export { claudeTranscriptProviderTurnId } from './agent-runner-transcript'

import {
  nativeClaudeToolActivity,
  nativeClaudeToolReturnMessage,
  nativeClaudeWorkflowObservation
} from './agent-runner-observation'

let counter = 0
const newId = (): string => `ev-${Date.now().toString(36)}-${(counter++).toString(36)}`
const now = (): string => new Date().toISOString()

export type EmitFn = (ev: TraceEvent) => void

let lastClaudeVersion: string | undefined
export const getClaudeVersion = (): string | undefined => lastClaudeVersion

export interface RunOpts {
  resume?: string
  cwd?: string
  // skill allowlist（启用的 skill 名）：SDK 的 skills 选项是 context filter——未列入的从模型 listing
  // 隐藏、且 Skill 工具拒绝调用，不碰 ~/.claude。空数组=全禁，故仅非空时传（见 index 计算逻辑）。
  skills?: string[]
  // 驱动哪个 claude 二进制：指向本机已装的 claude（默认行为）。
  // 不传时 SDK 用它 optionalDependency 里自带的二进制（dev 兜底）。打包不带自带二进制，必须传。
  claudePath?: string
  // 显式传给 spawn 的 claude 的环境：补全 launchd 极简环境缺的 PATH/会话变量，否则读不到 Keychain 登录态。
  env?: Record<string, string>
  settingSources?: Array<'user' | 'project' | 'local'>
  /** Main-owned structured authoring query; never a renderer permission switch. */
  authoringSchema?: Record<string, unknown>
  onSessionId?: (sessionId: string) => void
  historyReader?: HistoryReaderConnection
  /** Called immediately before releasing input to the SDK. */
  onInputAttempt?: () => void
  captureProviderTurnId?: boolean
  attachments?: AgentInputAttachment[]
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  model?: string
  effort?: string
  permissionMode?: AgentPermissionMode
  mcpServers?: Record<string, Record<string, unknown>>
  /** 双流事件日志的原生侧入口；未启用日志时调用方不传。 */
  recordNative?: (type: string, payload: unknown) => void
  /** Root Claude native model deltas only; diagnostic failures must not fail the run. */
  onWorkflowObservation?: (observation: WorkflowLiveObservation) => void
}

export interface RunHandle {
  promise: Promise<{
    sessionId?: string
    providerTurnId?: string
    stopped?: boolean
    status?: 'completed' | 'failed' | 'interrupted'
    mcpStatus?: McpLiveStatus[]
    structuredOutput?: ProviderStructuredOutput
  }>
  interrupt: () => void
  forceKill: () => void
  getSessionId: () => string | undefined
  getProviderTurnId?: () => string | undefined
}

function sdkPrompt(prompt: string, attachments: AgentInputAttachment[], beforeInput?: () => Promise<boolean>): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0 && !beforeInput) return prompt
  async function* stream(): AsyncIterable<SDKUserMessage> {
    if (beforeInput && !await beforeInput()) return
    const content: Array<Record<string, unknown>> = []
    if (prompt.trim()) content.push({ type: 'text', text: prompt })
    for (const attachment of attachments) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mimeType,
          data: attachment.dataBase64
        }
      })
    }
    yield ({
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null
    } as unknown as SDKUserMessage)
  }
  return stream()
}

export function runAgent(prompt: string, runId: string, emit: EmitFn, opts: RunOpts = {}): RunHandle {
  const ctx: NormalizeCtx = { runId, cwd: opts.cwd, newId, now }
  let stopped = false
  let sessionId: string | undefined
  let providerTurnId: string | undefined
  let transcriptPath: string | undefined
  let frozenTranscriptBaseline: TranscriptBaseline | undefined
  let stderrDiagnostic = ''
  let observationWarningLogged = false
  const workflowObserver = opts.onWorkflowObservation
  const observeWorkflow = workflowObserver && ((observation: WorkflowLiveObservation): void => {
    try { workflowObserver(observation) } catch (error) {
      if (!observationWarningLogged) {
        observationWarningLogged = true
        console.warn(`[scry] Claude workflow observation failed (${runId}):`, error)
      }
    }
  })
  let spawnedChild: ChildProcessWithoutNullStreams | undefined
  let spawnedIdentity: ProcessIdentity | undefined
  const captureSessionId = (next: string | undefined): void => {
    if (!next || sessionId === next) return
    sessionId = next
    opts.onSessionId?.(next)
  }

  const permissionMode = opts.permissionMode ?? 'default'
  const options = createAgentOptions(opts, {
    runId,
    permissionMode,
    onStderr: (data) => {
      stderrDiagnostic = sanitizeMcpAuthError(`${stderrDiagnostic}${data}`)
    },
    onUserPromptSubmit: async (payload) => {
      captureSessionId(hookString(payload, 'session_id', 'sessionId'))
      if (!providerTurnId && !isSyntheticPromptHook(payload)) {
        providerTurnId = nativeProviderTurnId(payload)
        const path = hookString(payload, 'transcript_path', 'transcriptPath')
        if (path && path !== transcriptPath) {
          transcriptPath = path
          frozenTranscriptBaseline = await transcriptBaseline(path)
        }
      }
    },
    onSpawnedProcess: (child) => {
      spawnedChild = child
      // Register the owned handle before sampling its identity, as in the original lifecycle.
      spawnedIdentity = captureProcessIdentity(child.pid)
    }
  })

  let releaseInput: ((allowed: boolean) => void) | undefined
  let inputAdmitted = false
  const admission = opts.historyReader ? new Promise<boolean>(resolve => { releaseInput = resolve }) : undefined
  const beforeInput = admission ? async (): Promise<boolean> => {
    if (!await admission || stopped) return false
    opts.onInputAttempt?.()
    inputAdmitted = true
    return true
  } : undefined
  if (!admission) opts.onInputAttempt?.()
  const q = query({ prompt: sdkPrompt(prompt, opts.attachments ?? [], beforeInput), options: options as never })

  const interrupt = (): void => {
    stopped = true
    if (admission && !inputAdmitted) { releaseInput?.(false); q.close(); return }
    try {
      const fn = (q as { interrupt?: () => unknown }).interrupt
      if (typeof fn === 'function') Promise.resolve(fn.call(q)).catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const forceKill = (): void => {
    stopped = true
    const child = spawnedChild
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32' || !spawnedIdentity?.startedAt) {
      // 没有进程组语义，或者身份没采集到：只能动 Node 自己持有的子进程句柄。
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      return
    }
    const outcome = signalProcessTreeWithIdentity({ identity: spawnedIdentity, signal: 'SIGKILL' })
    // 身份核对不过时不对进程组动手，但本进程持有的子进程句柄仍然是安全的（未被回收，PID 不会被复用）。
    if (outcome.status !== 'signalled') {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }

  const promise = (async () => {
    let mcpStatus: McpLiveStatus[] | undefined
    let runErr: unknown
    let providerStatus: 'completed' | 'failed' = 'completed'
    let sawTerminalResult = false
    let structuredOutput: ProviderStructuredOutput | undefined
    let streamedAssistantText = ''
    try {
      if (opts.historyReader) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const statuses = await Promise.race([
            (async () => { await q.initializationResult(); return q.mcpServerStatus() })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Claude 历史检索工具就绪超时，输入未投递')), 15_000)
              timer.unref()
            })
          ])
          const reader = statuses.find(server => server.name === HISTORY_READER_SERVER)
          if (reader?.status !== 'connected' || !reader.tools?.some(tool =>
            tool.name === HISTORY_READER_TOOL || tool.name === `mcp__${HISTORY_READER_SERVER}__${HISTORY_READER_TOOL}`)) {
            throw new Error('Claude 未确认历史检索工具可用，输入未投递')
          }
          releaseInput?.(!stopped)
        } finally { if (timer) clearTimeout(timer) }
      }
      for await (const msg of q) {
        const m = msg as {
          type?: string
          subtype?: string
          session_id?: string
          mcp_servers?: unknown
          claude_code_version?: string
          structured_output?: unknown
        }
        if (m.type === 'system' && m.subtype === 'init') {
          captureSessionId(m.session_id)
          if (m.claude_code_version) lastClaudeVersion = m.claude_code_version
          // MCP 真实状态在 init 消息里（name + status，含 needs-auth），和终端 /mcp 一致。
          // q.mcpServerStatus() 流结束后调会 "Query closed"，所以直接从 init 读。
          if (Array.isArray(m.mcp_servers)) {
            mcpStatus = (m.mcp_servers as Array<{ name?: string; status?: string }>).map((s) => ({
              name: String(s.name ?? ''),
              status: (s.status ?? 'pending') as McpLiveStatus['status']
            }))
          }
        }
        if (m.type === 'result') {
          sawTerminalResult = true
          captureSessionId(m.session_id)
        }
        if (opts.captureProviderTurnId && m.type === 'user' && !providerTurnId) {
          providerTurnId = nativeProviderTurnId(msg as unknown as Record<string, unknown>)
        }
        if (m.type === 'result' && (m.subtype !== 'success' || (msg as { is_error?: boolean }).is_error === true)) {
          providerStatus = 'failed'
        }
        if (opts.authoringSchema && m.type === 'result' && providerStatus === 'completed') {
          // Serialize once: later SDK mutation cannot change the canonical candidate.
          const json = JSON.stringify(m.structured_output)
          if (json !== undefined) {
            if (Buffer.byteLength(json) > WORKFLOW_MAX_VALUE_BYTES) throw new Error(workflowAuthoringCopy.outputTooLarge)
            structuredOutput = { source: 'claude_sdk_success_result', json }
          }
        }
        opts.recordNative?.(m.type ?? 'unknown', msg)
        const rawMessage = msg as unknown as Record<string, unknown>
        if (observeWorkflow) {
          const observation = nativeClaudeWorkflowObservation(rawMessage) ?? nativeClaudeToolActivity(rawMessage, sessionId, ctx)
          if (observation) observeWorkflow(observation)
        }
        const events = normalizeSdkMessage(msg, ctx,
          observeWorkflow && nativeClaudeToolReturnMessage(rawMessage, sessionId)
            ? toolCallId => observeWorkflow({ source: 'claude_native', kind: 'tool_returned', toolCallId })
            : undefined)
        if (m.type === 'stream_event') {
          for (const event of events) {
            if (event.kind === 'model' && event.stage === 'text_delta') streamedAssistantText += event.text ?? ''
          }
        }
        const assistantText =
          m.type === 'assistant'
            ? events
                .filter((event) => event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta'))
                .map((event) => event.text ?? '')
                .join('')
            : ''
        const duplicateAssistantSnapshot = streamedAssistantText.length > 0 && assistantText === streamedAssistantText
        for (const event of events) {
          if (duplicateAssistantSnapshot && event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta')) continue
          emit(event)
        }
        if (m.type === 'assistant') streamedAssistantText = ''
      }
    } catch (err) {
      if (!stopped) runErr = err // 用户主动 interrupt 引发的中断不算错误
    } finally {
      if (admission) { releaseInput?.(false); q.close() }
    }
    if (opts.captureProviderTurnId && !providerTurnId && transcriptPath && frozenTranscriptBaseline) {
      providerTurnId = await providerTurnIdFromTranscript(transcriptPath, prompt, sessionId, frozenTranscriptBaseline)
    }
    if (runErr) {
      if (stderrDiagnostic.trim()) console.warn(`[scry] Claude stderr (${runId}, redacted):`, stderrDiagnostic.trim())
      throw runErr
    }
    if (!stopped && !sawTerminalResult) {
      if (stderrDiagnostic.trim()) console.warn(`[scry] Claude stderr (${runId}, redacted):`, stderrDiagnostic.trim())
      throw new Error('Claude Agent SDK stream ended without a terminal result')
    }
    return {
      sessionId,
      providerTurnId,
      stopped,
      status: stopped ? ('interrupted' as const) : providerStatus,
      mcpStatus,
      ...(!stopped && providerStatus === 'completed' && structuredOutput ? { structuredOutput } : {})
    }
  })()

  return {
    promise,
    interrupt,
    forceKill,
    getSessionId: () => sessionId,
    getProviderTurnId: () => providerTurnId
  }
}
