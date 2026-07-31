// 模式 A：用 Claude Agent SDK 驱动 claude，把 message stream 归一化成 TraceEvent 流式 emit。
// 支持多轮对话（resume）+ 工作目录（cwd）+ 中断（interrupt）+ subagent 内部明细（tail transcript 一层）。

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type TraceEvent, type McpLiveStatus } from '../shared/trace'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  normalizeAgentQuestionRequest,
  type AgentInputAttachment,
  type AgentPermissionMode,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '../shared/runtime'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'

let counter = 0
const newId = (): string => `ev-${Date.now().toString(36)}-${(counter++).toString(36)}`
const now = (): string => new Date().toISOString()

export type EmitFn = (ev: TraceEvent) => void

// P2 Diagnostics：最近一次会话 init 报的 claude 二进制版本（驱动会话的真实 claude 版本）
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
  onSessionId?: (sessionId: string) => void
  attachments?: AgentInputAttachment[]
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  model?: string
  effort?: string
  permissionMode?: AgentPermissionMode
  mcpServers?: Record<string, Record<string, unknown>>
}

export interface RunHandle {
  promise: Promise<{ sessionId?: string; stopped?: boolean; mcpStatus?: McpLiveStatus[] }>
  interrupt: () => void
  getSessionId: () => string | undefined
}

function sdkPrompt(prompt: string, attachments: AgentInputAttachment[]): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0) return prompt
  async function* stream(): AsyncIterable<SDKUserMessage> {
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
  const captureSessionId = (next: string | undefined): void => {
    if (!next || sessionId === next) return
    sessionId = next
    opts.onSessionId?.(next)
  }

  const permissionMode = opts.permissionMode ?? 'default'
  const options: Record<string, unknown> = {
    // C1：开 partial messages，让模型文本逐 token 流式到达（否则只在整条 assistant message 完成时整块出现）。
    includePartialMessages: true,
    // P1（RFC §7/§8.2）：开 forwardSubagentText → subagent 的 text/thinking 也作为带 parent_tool_use_id
    // 的 message 上主流（probe 实测 subagent msg 的 parent_tool_use_id = 父 Agent tool_use_id），
    // Execution Graph 据此挂父。默认 false 只发 tool_use/tool_result。
    // 二选一防双采（RFC NIT-1）：开了 forward 就不再装 SubagentStop tail（否则 subagent 内容主流 + tail 各采一遍）。
    forwardSubagentText: true,
    // Hook 可观测：让 SDK 把 hook_started/progress/response 放进 message stream，normalize 后进右栏面板。
    includeHookEvents: true
  }
  if (permissionMode === 'full_access') {
    options.permissionMode = 'bypassPermissions'
    options.allowDangerouslySkipPermissions = true
    options.extraArgs = { 'dangerously-skip-permissions': null }
  } else if (permissionMode === 'auto_review') {
    options.permissionMode = 'auto'
  }
  if (opts.model) options.model = opts.model
  if (opts.effort) options.effort = opts.effort
  if (opts.resume) options.resume = opts.resume
  if (opts.cwd) options.cwd = opts.cwd
  // 指向本机已装的 claude 原生二进制（选 B：不内嵌 SDK 自带的 216MB 二进制）。
  if (opts.claudePath) options.pathToClaudeCodeExecutable = opts.claudePath
  // 显式传完整登录环境，修 launchd 启动的打包 app spawn claude 时 "Not logged in"。
  if (opts.env) options.env = opts.env
  if (opts.settingSources?.length) options.settingSources = opts.settingSources
  options.strictMcpConfig = true
  options.mcpServers = opts.mcpServers ?? {}
  if (opts.requestUserInput) {
    options.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      permission: {
        signal: AbortSignal
        toolUseID: string
        agentID?: string
        suggestions?: unknown[]
        title?: string
        description?: string
      }
    ) => {
      if (toolName === 'AskUserQuestion') {
        const request = normalizeAgentQuestionRequest(runId, permission.toolUseID, input, permission.agentID)
        if (!request) return { behavior: 'deny' as const, message: 'Scry 收到的提问格式无效', interrupt: false }
        const response = await opts.requestUserInput!(request, permission.signal)
        if (response.behavior === 'cancelled') {
          return { behavior: 'deny' as const, message: '用户取消了提问', interrupt: false, decisionClassification: 'user_reject' as const }
        }
        return {
          behavior: 'allow' as const,
          updatedInput: { ...input, answers: response.answers },
          decisionClassification: 'user_temporary' as const
        }
      }
      if (permissionMode === 'full_access') return { behavior: 'allow' as const }
      const detail = permission.description ?? JSON.stringify(input).slice(0, 1_200)
      const request = agentPermissionQuestion(
        runId,
        permission.toolUseID,
        permission.title ?? '权限请求',
        `允许 ${toolName} 执行这项操作吗？`,
        detail
      )
      const response = await opts.requestUserInput!(request, permission.signal)
      const decision = agentPermissionDecision(request, response)
      if (decision === 'reject') {
        return { behavior: 'deny' as const, message: '用户拒绝了操作', interrupt: false, decisionClassification: 'user_reject' as const }
      }
      return {
        behavior: 'allow' as const,
        ...(decision === 'session' && permission.suggestions?.length
          ? { updatedPermissions: permission.suggestions }
          : {}),
        decisionClassification: decision === 'session' ? 'user_permanent' as const : 'user_temporary' as const
      }
    }
  }
  // C4：Skill 软屏蔽 —— 只影响 app 驱动的会话，不动用户终端的 claude
  // C4：skill 软屏蔽 → 改用 SDK 的 skills allowlist（硬过滤：未列入的隐藏+拒调用）。
  // 软指令实测压不住「列出全部 skill」，故弃用 appendSystemPrompt 改 allowlist。
  if (opts.skills?.length) options.skills = opts.skills

  const q = query({ prompt: sdkPrompt(prompt, opts.attachments ?? []), options: options as never })

  const interrupt = (): void => {
    stopped = true
    try {
      const fn = (q as { interrupt?: () => unknown }).interrupt
      if (typeof fn === 'function') Promise.resolve(fn.call(q)).catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const promise = (async () => {
    let mcpStatus: McpLiveStatus[] | undefined
    let runErr: unknown
    let streamedAssistantText = ''
    try {
      for await (const msg of q) {
        const m = msg as {
          type?: string
          subtype?: string
          session_id?: string
          mcp_servers?: unknown
          claude_code_version?: string
        }
        if (m.type === 'system' && m.subtype === 'init') {
          captureSessionId(m.session_id)
          if (m.claude_code_version) lastClaudeVersion = m.claude_code_version // P2 Diagnostics
          // MCP 真实状态在 init 消息里（name + status，含 needs-auth），和终端 /mcp 一致。
          // q.mcpServerStatus() 流结束后调会 "Query closed"，所以直接从 init 读。
          if (Array.isArray(m.mcp_servers)) {
            mcpStatus = (m.mcp_servers as Array<{ name?: string; status?: string }>).map((s) => ({
              name: String(s.name ?? ''),
              status: (s.status ?? 'pending') as McpLiveStatus['status']
            }))
          }
        }
        if (m.type === 'result') captureSessionId(m.session_id)
        const events = normalizeSdkMessage(msg, ctx)
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
    }
    if (runErr) throw runErr
    return { sessionId, stopped, mcpStatus }
  })()

  return { promise, interrupt, getSessionId: () => sessionId }
}
