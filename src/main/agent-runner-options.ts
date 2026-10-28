import { type HookInput, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { type RunOpts } from './agent-runner'
import { workflowAuthoringCopy } from '../shared/constants/copy'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  normalizeAgentQuestionRequest,
  sanitizeApprovalWarning
} from '../shared/runtime'

export type AgentOptionContext = {
  runId: string
  permissionMode: NonNullable<RunOpts['permissionMode']>
  onUserPromptSubmit: (payload: Record<string, unknown>) => Promise<void>
  onStderr: (data: string) => void
  onSpawnedProcess: (child: ChildProcessWithoutNullStreams) => void
}

export function createAgentOptions(opts: RunOpts, context: AgentOptionContext): Record<string, unknown> {
  if (opts.authoringSchema && (context.permissionMode !== 'default' || opts.resume || opts.historyReader)) {
    throw new Error(workflowAuthoringCopy.invalidContext)
  }
  const options: Record<string, unknown> = {
    // C1：开 partial messages，让模型文本逐 token 流式到达（否则只在整条 assistant message 完成时整块出现）。
    includePartialMessages: true,
    // P1（RFC §7/§8.2）：开 forwardSubagentText → subagent 的 text/thinking 也作为带 parent_tool_use_id
    // 的 message 上主流（probe 实测 subagent msg 的 parent_tool_use_id = 父 Agent tool_use_id），
    // Execution Graph 据此挂父。默认 false 只发 tool_use/tool_result。
    // 二选一防双采（RFC NIT-1）：开了 forward 就不再装 SubagentStop tail（否则 subagent 内容主流 + tail 各采一遍）。
    forwardSubagentText: true,
    // Hook 可观测：让 SDK 把 hook_started/progress/response 放进 message stream，normalize 后进右栏面板。
    includeHookEvents: true,
    // SDK 默认丢弃 child stderr。只在异常终态打印最近 2KB，且复用现有凭据脱敏规则。
    stderr: (data: string) => {
      context.onStderr(data)
    }
  }
  if (opts.captureProviderTurnId) {
    options.hooks = {
      UserPromptSubmit: [{
        hooks: [async (input: HookInput) => {
          const payload = input as unknown as Record<string, unknown>
          await context.onUserPromptSubmit(payload)
          return { continue: true }
        }]
      }]
    }
  }
  if (context.permissionMode === 'full_access') {
    options.permissionMode = 'bypassPermissions'
    options.allowDangerouslySkipPermissions = true
    options.extraArgs = { 'dangerously-skip-permissions': null }
  } else if (context.permissionMode === 'auto_review') {
    options.permissionMode = 'auto'
  } else if (context.permissionMode === 'auto_accept_edits') {
    // Claude Agent SDK 的原生档位：文件编辑直接放行，其余工具仍走 canUseTool 审批。
    options.permissionMode = 'acceptEdits'
  }
  if (opts.model) options.model = opts.model
  if (opts.effort) options.effort = opts.effort
  if (opts.resume) options.resume = opts.resume
  if (opts.cwd) options.cwd = opts.cwd
  // 指向本机已装的 claude 原生二进制（选 B：不内嵌 SDK 自带的 216MB 二进制）。
  if (opts.claudePath) options.pathToClaudeCodeExecutable = opts.claudePath
  // 显式传完整登录环境，修 launchd 启动的打包 app spawn claude 时 "Not logged in"。
  if (opts.env) options.env = opts.env
  // The SDK treats [] as explicit filesystem-settings isolation; omission loads all sources.
  if (opts.settingSources !== undefined) options.settingSources = opts.settingSources
  options.spawnClaudeCodeProcess = (spawnOptions: {
    command: string
    args: string[]
    cwd?: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }) => {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: process.platform !== 'win32',
      signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    context.onSpawnedProcess(child)
    return child
  }
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
        suggestions?: PermissionUpdate[]
        title?: string
        description?: string
        /** SDK 给出的触发原因（例如 ask 规则、路径越界、可疑内容）。 */
        decisionReason?: string
        /** 触发这次审批的路径，例如 Bash 想访问允许目录之外的文件。 */
        blockedPath?: string
      }
    ) => {
      if (toolName === 'AskUserQuestion') {
        const request = normalizeAgentQuestionRequest(
          context.runId,
          permission.toolUseID,
          input,
          permission.agentID,
          'claude:AskUserQuestion'
        )
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
      if (context.permissionMode === 'full_access') return { behavior: 'allow' as const }
      const detail = permission.description ?? JSON.stringify(input).slice(0, 1_200)
      const sessionSuggestions = exactSessionPermissionSuggestions(permission.suggestions)
      const sessionDescription = exactSessionPermissionDescription(sessionSuggestions)
      // Provider 说明了为什么要问就原样（脱敏后）转述；没说明就不编造风险理由。
      const warning = [
        sanitizeApprovalWarning(permission.decisionReason),
        permission.blockedPath ? sanitizeApprovalWarning(`越界路径：${permission.blockedPath}`, 200) : undefined
      ].filter(Boolean).join('；') || undefined
      const request = agentPermissionQuestion(
        context.runId,
        permission.toolUseID,
        permission.title ?? '权限请求',
        `允许 ${toolName} 执行这项操作吗？`,
        detail,
        sessionDescription !== undefined,
        `claude:permission:${toolName}`,
        sessionDescription,
        warning
      )
      const response = await opts.requestUserInput!(request, permission.signal)
      const decision = agentPermissionDecision(request, response)
      if (decision === 'reject') {
        return { behavior: 'deny' as const, message: '用户拒绝了操作', interrupt: false, decisionClassification: 'user_reject' as const }
      }
      const applySessionSuggestions = decision === 'session' && sessionDescription !== undefined
      return {
        behavior: 'allow' as const,
        ...(applySessionSuggestions
          ? { updatedPermissions: sessionSuggestions }
          : {}),
        decisionClassification: applySessionSuggestions ? 'user_permanent' as const : 'user_temporary' as const
      }
    }
  }
  // C4：Skill 软屏蔽 —— 只影响 app 驱动的会话，不动用户终端的 claude
  // C4：skill 软屏蔽 → 改用 SDK 的 skills allowlist（硬过滤：未列入的隐藏+拒调用）。
  // 软指令实测压不住「列出全部 skill」，故弃用 appendSystemPrompt 改 allowlist。
  if (opts.skills?.length) options.skills = opts.skills
  if (opts.authoringSchema) {
    // Native SDK controls, not prompt-only restrictions or a security sandbox.
    // This purpose is fresh and configuration-independent; normal runs retain
    // their existing tools, permissions, hooks, settings and memory behavior.
    Object.assign(options, {
      tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      plugins: [], skills: [], hooks: {},
      settings: { disableAllHooks: true, autoMemoryEnabled: false, autoDreamEnabled: false },
      systemPrompt: 'Return only the requested structured result. Do not execute tools or load external context.',
      outputFormat: { type: 'json_schema', schema: structuredClone(opts.authoringSchema) },
      maxTurns: 1,
      canUseTool: async () => ({ behavior: 'deny', message: workflowAuthoringCopy.hostToolsDisabled, interrupt: true })
    })
  }
  return options
}
