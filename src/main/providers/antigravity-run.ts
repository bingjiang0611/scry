import { homedir } from 'node:os'
import type { AgentQuestionResponse, AgentInputAttachment } from '../../shared/runtime'
import { maskSecrets } from '../../shared/trace'
import {
  detectStrippedAntigravityEnvNames,
  explicitlyAllowedProviderEnvKeys
} from '../provider-environment'
import { shellEnv } from '../claude-locate'
import { AcpClient, AcpRpcError, type AcpInitializeResult, type AcpJsonRpcId } from './acp-client'
import { AntigravityEventTranslator } from './antigravity-events'
import {
  AntigravityStderrTail,
  buildAntigravityLaunchEnv,
  forceKillAntigravityProcess,
  signalAntigravityProcess,
  spawnAntigravityAcp
} from './antigravity-launch'
import { collectAllowCapablePreToolUseMatchers } from './antigravity-mcp-paths'
import {
  antigravityNativeModeFor,
  assertUserSettingsWithinRequestedMode,
  buildAntigravityQuestionRequest,
  isAntigravityAllowAlwaysOption,
  resolveAntigravityPermissionOutcome,
  type AcpPermissionRequestParams
} from './antigravity-permissions'
import { buildAntigravityResultEvent, type AcpPromptUsage } from './antigravity-usage'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

const IDLE_TIMEOUT_MS = 15 * 60_000
const NATURAL_EXIT_GRACE_MS = 3_000

export interface AntigravityRunDeps {
  homeDir?: string
  clientVersion?: string
  /** Acquire a shared run slot (concurrent runs allowed; never overlaps catalog probes, B2/D5). */
  acquireRunSlot?: (signal?: AbortSignal) => Promise<() => void>
  /** Optional A6 workspace config trust gate executed after slot acquisition (fail closed). */
  checkWorkspaceTrust?: (cwd: string) => void | Promise<void>
  /** Optional extra ACP `mcpServers` entries (e.g. A6 run-scoped history reader) + extra env & cleanup. */
  prepareMcp?: (request: ProviderRunRequest, baseEnv?: Record<string, string>) => Promise<{
    mcpServers: Array<Record<string, unknown>>
    extraEnv?: Record<string, string>
    dispose?: () => Promise<void> | void
  }>
}

function isAuthFailure(error: unknown, loginPromptDetected: boolean): boolean {
  if (loginPromptDetected) return true
  if (error instanceof AcpRpcError) {
    if (error.code === -32000) return true
    if (error.code === -32603 && /no browser|auth|login|sign in/i.test(error.message)) return true
  }
  return false
}

export function formatAntigravityUnauthenticatedError(rawEnv: Record<string, string | undefined>): string {
  const base = 'Antigravity 未登录：在终端运行 agy 完成登录（或 agy acp --login），再回到 Scry 刷新'
  const stripped = detectStrippedAntigravityEnvNames(rawEnv)
  if (stripped.length === 0) return base
  return `${base}（检测到已清洗的环境变量：${stripped.join(', ')}；如需使用请配置 SCRY_PROVIDER_ENV_ALLOW=antigravity:<NAME>）`
}

function buildPromptBlocks(
  prompt: string,
  attachments: readonly AgentInputAttachment[],
  init: AcpInitializeResult
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (prompt) blocks.push({ type: 'text', text: prompt })
  const supportsImage = init.agentCapabilities?.promptCapabilities?.image !== false
  for (const att of attachments) {
    const kind = (att as { kind?: string }).kind
    if (kind === 'audio') {
      throw new Error('Antigravity ACP 不支持音频附件（promptCapabilities.audio=false）')
    }
    if (att.kind === 'image') {
      if (!supportsImage) throw new Error('Antigravity ACP 当前不支持图片附件')
      blocks.push({ type: 'image', data: att.dataBase64, mimeType: att.mimeType })
    } else if (att.path) {
      blocks.push({ type: 'text', text: `[Attachment path: ${att.path}]` })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

interface PendingPermission {
  abort: AbortController
  cancelReply: () => void
}

export function runAntigravity(
  request: ProviderRunRequest,
  deps: AntigravityRunDeps = {}
): ProviderRunHandle {
  const homeDir = deps.homeDir ?? homedir()
  const cwd = request.cwd ?? process.cwd()
  const permissionMode = request.permissionMode ?? 'default'

  let externalSessionId: string | undefined = request.resume
  let sessionEstablished = false
  let cancelRequested = false
  let forceKillRequested = false
  let activeClient: AcpClient | undefined
  let activeIdentityPromise: ReturnType<typeof spawnAntigravityAcp>['identityPromise'] | undefined
  let forceKillPromise: Promise<void> | undefined
  const pendingPermissions = new Map<string, PendingPermission>()
  const queueAbort = new AbortController()

  const runForceKillOnce = (): Promise<void> | undefined => {
    if (!activeIdentityPromise) return undefined
    if (!forceKillPromise) forceKillPromise = forceKillAntigravityProcess(activeIdentityPromise)
    return forceKillPromise
  }

  const cancelAllPendingPermissions = (): void => {
    for (const pending of pendingPermissions.values()) {
      pending.abort.abort()
      pending.cancelReply()
    }
    pendingPermissions.clear()
  }

  const interrupt = (): void => {
    cancelRequested = true
    queueAbort.abort()
    cancelAllPendingPermissions()
    if (sessionEstablished && externalSessionId && activeClient && !activeClient.isClosed) {
      activeClient.notify('session/cancel', { sessionId: externalSessionId })
    } else if (activeIdentityPromise) {
      void signalAntigravityProcess(activeIdentityPromise, 'SIGTERM')
    }
  }

  const forceKill = (): void => {
    cancelRequested = true
    forceKillRequested = true
    queueAbort.abort()
    cancelAllPendingPermissions()
    // Snapshot and signal the process tree BEFORE closing stdin so root does not exit on EOF
    // and reparent independent-PGID descendants before ps can observe them (S6).
    void runForceKillOnce()
    activeClient?.destroy({ closeStdin: false })
  }

  const promise = (async (): Promise<ProviderRunResult> => {
    const startedAt = Date.now()
    const rawEnv: Record<string, string | undefined> = { ...shellEnv(), ...process.env }
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawEnv)) if (v !== undefined) baseEnv[k] = v

    const emitPreSpawnCancelled = (): ProviderRunResult => {
      request.emit(buildAntigravityResultEvent({
        runId: request.runId,
        durationMs: Date.now() - startedAt,
        isError: false,
        stopReason: 'cancelled',
        effectivePermissionMode: permissionMode,
        usage: null,
        contextUsage: null,
        cancelled: true,
        failed: false,
        hasSubagentTool: false,
        nonJsonLineCount: 0
      }))
      return { externalSessionId, stopped: true, status: 'cancelled' }
    }

    if (cancelRequested) return emitPreSpawnCancelled()

    let releaseRunSlot: (() => void) | undefined
    try {
      releaseRunSlot = deps.acquireRunSlot ? await deps.acquireRunSlot(queueAbort.signal) : undefined
    } catch (slotErr) {
      if (cancelRequested || (slotErr instanceof Error && slotErr.message === 'antigravity_run_cancelled_before_start')) {
        return emitPreSpawnCancelled()
      }
      throw slotErr
    }

    let mcpPrepared: {
      mcpServers: Array<Record<string, unknown>>
      extraEnv?: Record<string, string>
      dispose?: () => Promise<void> | void
    } = { mcpServers: [] }

    const stderrTail = new AntigravityStderrTail()
    let spawned: ReturnType<typeof spawnAntigravityAcp> | undefined
    let client: AcpClient | undefined
    let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const clearIdle = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    try {
      if (cancelRequested) return emitPreSpawnCancelled()

      // B1: derive `.gemini` root from the exact sanitized launch env that `agy acp` receives.
      const sanitizedEnv = buildAntigravityLaunchEnv(baseEnv)
      const userPermCheck = assertUserSettingsWithinRequestedMode(permissionMode, homeDir, sanitizedEnv)
      if (deps.checkWorkspaceTrust) await deps.checkWorkspaceTrust(cwd)
      if (cancelRequested) return emitPreSpawnCancelled()

      if (deps.prepareMcp) mcpPrepared = await deps.prepareMcp(request, baseEnv)
      if (cancelRequested) return emitPreSpawnCancelled()

      const allowCapablePreToolUseMatchers = collectAllowCapablePreToolUseMatchers(cwd, homeDir, sanitizedEnv)

      spawned = spawnAntigravityAcp({
        cwd,
        permissionMode,
        baseEnv,
        extraEnv: mcpPrepared.extraEnv,
        stderrTail
      })
      activeIdentityPromise = spawned.identityPromise
      const child = spawned.child
      exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })

      const translator = new AntigravityEventTranslator(request.runId, request.emit, {
        permissionMode: permissionMode === 'default' || permissionMode === 'auto_accept_edits' || permissionMode === 'full_access'
          ? permissionMode
          : 'default',
        allowCapablePreToolUseMatchers,
        hasUserAllowRules: userPermCheck.allowRules.length > 0
      })
      let inPrompt = false
      let idleTimedOut = false

      const resetIdle = (): void => {
        clearIdle()
        if (!inPrompt || pendingPermissions.size > 0) return
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          forceKill()
        }, IDLE_TIMEOUT_MS)
      }

      let permSeq = 0
      client = new AcpClient(child, {
        onRawMessage: (direction, rawLine) => {
          // Record ONLY incoming raw agent JSON-RPC lines verbatim (NEVER maskSecrets!).
          if (direction === 'in') request.recordNative?.('antigravity_acp_message', rawLine)
        },
        onNotification: (method, params) => {
          translator.handleNotification(method, params)
          resetIdle()
        },
        onRequest: async (method, params, _id: AcpJsonRpcId) => {
          if (method !== 'session/request_permission') return undefined
          const permParams = (params && typeof params === 'object' ? params : {}) as AcpPermissionRequestParams
          translator.markPermissionAsked(permParams.toolCall?.toolCallId)
          translator.ensureToolCall(permParams.toolCall as Record<string, unknown> | undefined)
          if (cancelRequested || !request.requestUserInput) {
            return { outcome: { outcome: 'cancelled' } }
          }
          const questionId = `${request.runId}:agy-perm:${++permSeq}`
          const { request: qReq, optionIdByAnswer } = buildAntigravityQuestionRequest({
            runId: request.runId,
            questionId,
            params: permParams
          })
          const abort = new AbortController()
          clearIdle()
          let settled = false
          return await new Promise((resolve) => {
            const finish = (outcome: ReturnType<typeof resolveAntigravityPermissionOutcome>): void => {
              if (settled) return
              settled = true
              pendingPermissions.delete(questionId)
              resetIdle()
              resolve(outcome)
            }
            pendingPermissions.set(questionId, {
              abort,
              cancelReply: () => finish({ outcome: { outcome: 'cancelled' } })
            })
            void Promise.resolve(request.requestUserInput!(qReq, abort.signal))
              .then((response: AgentQuestionResponse) => {
                const resolved = resolveAntigravityPermissionOutcome(qReq, response, optionIdByAnswer)
                if (resolved.outcome.outcome === 'selected' && isAntigravityAllowAlwaysOption(permParams.options, resolved.outcome.optionId)) {
                  translator.markAllowAlwaysSelected()
                }
                finish(resolved)
              })
              .catch(() => {
                finish({ outcome: { outcome: 'cancelled' } })
              })
          })
        },
        onProtocolError: () => {
          forceKill()
        }
      })
      activeClient = client

      const init = await client.initialize(deps.clientVersion ?? '0.2.250')
      const allowedEnv = explicitlyAllowedProviderEnvKeys(rawEnv.SCRY_PROVIDER_ENV_ALLOW, 'antigravity')

      const openSession = async (): Promise<string> => {
        const mcpServers = mcpPrepared.mcpServers
        if (request.resume) {
          try {
            const resumed = await client!.request<{ sessionId?: string }>('session/resume', {
              sessionId: request.resume,
              cwd,
              mcpServers
            })
            return resumed?.sessionId || request.resume
          } catch (resumeErr) {
            if (isAuthFailure(resumeErr, client!.loginPromptDetected)) throw resumeErr
            // Fallback to `session/load`, suppressing replayed history notifications (P7 §3).
            translator.suppressReplay = true
            try {
              const loaded = await client!.request<{ sessionId?: string }>('session/load', {
                sessionId: request.resume,
                cwd,
                mcpServers
              })
              return loaded?.sessionId || request.resume
            } finally {
              translator.suppressReplay = false
            }
          }
        }
        const created = await client!.request<{ sessionId: string }>('session/new', { cwd, mcpServers })
        if (!created?.sessionId) throw new Error('Antigravity ACP session/new 未返回 sessionId')
        return created.sessionId
      }

      let sid: string
      try {
        sid = await openSession()
      } catch (err) {
        if (err instanceof AcpRpcError && err.code === -32000 && !client.loginPromptDetected) {
          // Only call non-browser `authenticate` when user explicitly allowed API key or ADC env vars (P7 §2.2).
          if (allowedEnv.has('GEMINI_API_KEY') && rawEnv.GEMINI_API_KEY) {
            await client.request('authenticate', { methodId: 'gemini-api-key' })
            sid = await openSession()
          } else if (allowedEnv.has('AGY_ADC_AUTH') && rawEnv.AGY_ADC_AUTH && (rawEnv.GOOGLE_CLOUD_PROJECT || rawEnv.GCLOUD_PROJECT)) {
            await client.request('authenticate', { methodId: 'agent-platform' })
            sid = await openSession()
          } else {
            throw err
          }
        } else {
          throw err
        }
      }

      externalSessionId = sid
      sessionEstablished = true
      request.onExternalSessionId?.(sid)

      if (request.model?.id) {
        await client.request('session/set_config_option', {
          sessionId: sid,
          configId: 'model',
          value: request.model.id
        })
      }
      if (request.effort) {
        await client.request('session/set_config_option', {
          sessionId: sid,
          configId: 'thought_level',
          value: request.effort
        })
      }
      const nativeMode = antigravityNativeModeFor(permissionMode)
      if (nativeMode) {
        await client.request('session/set_mode', { sessionId: sid, modeId: nativeMode })
      }

      const blocks = buildPromptBlocks(request.prompt, request.attachments, init)
      if (cancelRequested) {
        request.emit(buildAntigravityResultEvent({
          runId: request.runId,
          durationMs: Date.now() - startedAt,
          isError: false,
          stopReason: 'cancelled',
          effectivePermissionMode: userPermCheck.effectivePermissionMode,
          userAllowRules: userPermCheck.allowRules,
          userAllowNotice: userPermCheck.userAllowNotice,
          usage: null,
          contextUsage: translator.contextUsage,
          cancelled: true,
          failed: false,
          hasSubagentTool: translator.hasSubagentTool,
          nonJsonLineCount: client.nonJsonLineCount
        }))
        return { externalSessionId: sid, stopped: true, status: 'cancelled' }
      }

      inPrompt = true
      resetIdle()
      let promptResult: { stopReason?: string; usage?: AcpPromptUsage } | undefined
      try {
        promptResult = await client.request<{ stopReason?: string; usage?: AcpPromptUsage }>(
          'session/prompt',
          { sessionId: sid, prompt: blocks },
          { timeoutMs: null }
        )
      } catch (promptErr) {
        inPrompt = false
        clearIdle()
        if (idleTimedOut) {
          throw new Error('Antigravity ACP 运行超过 15 分钟无响应，已强制终止')
        }
        if (cancelRequested) {
          const rpcCode = promptErr instanceof AcpRpcError ? promptErr.code : undefined
          request.emit(buildAntigravityResultEvent({
            runId: request.runId,
            durationMs: Date.now() - startedAt,
            isError: false,
            stopReason: rpcCode !== undefined ? `cancelled_rpc_${rpcCode}` : 'cancelled',
            effectivePermissionMode: userPermCheck.effectivePermissionMode,
            userAllowRules: userPermCheck.allowRules,
            userAllowNotice: userPermCheck.userAllowNotice,
            usage: null,
            contextUsage: translator.contextUsage,
            cancelled: true,
            failed: false,
            hasSubagentTool: translator.hasSubagentTool,
            nonJsonLineCount: client.nonJsonLineCount
          }))
          return { externalSessionId: sid, stopped: true, status: 'cancelled' }
        }
        throw promptErr
      } finally {
        inPrompt = false
        clearIdle()
      }

      const stopReason = promptResult?.stopReason ?? 'end_turn'
      const cancelled = stopReason === 'cancelled'
      const cancelRequestedBeforeEndTurn = cancelRequested && !cancelled
      request.emit(buildAntigravityResultEvent({
        runId: request.runId,
        durationMs: Date.now() - startedAt,
        isError: false,
        stopReason,
        cancelRequestedBeforeEndTurn,
        effectivePermissionMode: userPermCheck.effectivePermissionMode,
        userAllowRules: userPermCheck.allowRules,
        userAllowNotice: userPermCheck.userAllowNotice,
        usage: promptResult?.usage ?? null,
        contextUsage: translator.contextUsage,
        cancelled,
        failed: false,
        hasSubagentTool: translator.hasSubagentTool,
        nonJsonLineCount: client.nonJsonLineCount
      }))
      return {
        externalSessionId: sid,
        ...(cancelled ? { stopped: true, status: 'cancelled' as const } : { status: 'completed' as const })
      }
    } catch (error) {
      if (isAuthFailure(error, client?.loginPromptDetected === true)) {
        await forceKillAntigravityProcess(activeIdentityPromise)
        throw new Error(formatAntigravityUnauthenticatedError(rawEnv))
      }
      const wrapped = error instanceof Error ? error : new Error(String(error))
      wrapped.message = maskSecrets(wrapped.message) ?? wrapped.message
      stderrTail.attach(wrapped)
      throw wrapped
    } finally {
      clearIdle()
      cancelAllPendingPermissions()
      if (exitPromise && activeIdentityPromise) {
        if (forceKillRequested) {
          await runForceKillOnce()
          if (client) client.closeStdin()
        } else {
          if (client) client.closeStdin()
          const exited = await Promise.race([
            exitPromise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), NATURAL_EXIT_GRACE_MS))
          ])
          if (!exited) await runForceKillOnce()
        }
      } else if (client) {
        client.closeStdin()
      }
      await mcpPrepared.dispose?.()
      releaseRunSlot?.()
    }
  })()

  return {
    promise,
    interrupt,
    forceKill,
    forceKillScope: 'run_scoped',
    getExternalSessionId: () => externalSessionId
  }
}
