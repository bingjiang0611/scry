import { randomUUID } from 'node:crypto'
import type { Query } from '@qoder-ai/qoder-agent-sdk'
import type { NormalizeCtx } from '../normalize-core'
import { normalizeQoderMessage } from './qoder-messages'
import { heldPrompt, qoderSessionOptions, signalProcessTree } from './qoder-launch'
import { qoderQuery, startQoderDaemon, type QoderDaemonLease } from './qoder-daemon'
import { qoderMcpSnapshot } from './qoder-mcp'
import { newId } from './qoder-shared'
import { qoderContextTokensFromUsage, qoderTrace } from './qoder-evidence'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

/**
 * `/plugins reload` 是 Qoder 原生控制命令，不投递模型输入，因此没有输入回执。
 * 统一对话一旦需要可验证回执，就走普通 run 由 HistoricalInput 拒绝斜杠命令。
 */
export function runQoderPluginReload(
  request: ProviderRunRequest,
  onPluginsReloaded: () => void
): ProviderRunHandle {
    const controller = new AbortController()
    const prompt = heldPrompt()
    let stopped = false
    let externalSessionId = request.resume
    // `/plugins reload` sends no prompt, so no message may ever carry the session id.
    // Scry names the new session itself (the daemon honors it) and adopts that id once
    // the Provider has answered.
    const requestedSessionId = request.resume ? undefined : randomUUID()
    const adoptSessionId = (id: string): void => {
      if (id === externalSessionId) return
      externalSessionId = id
      request.onExternalSessionId?.(id)
    }
    let q: Query | undefined
    let lease: QoderDaemonLease | undefined
    const ctx: NormalizeCtx = {
      runId: request.runId,
      cwd: request.cwd,
      newId,
      now: () => new Date().toISOString(),
      contextTokensFromUsage: qoderContextTokensFromUsage
    }
    const promise: Promise<ProviderRunResult> = (async () => {
      lease = await startQoderDaemon({
        managedRecorder: request.managedRecorder === true,
        managedIdentity: request.managedRecorderIdentity
      })
      if (stopped) {
        await lease.stop()
        return { stopped: true, status: 'interrupted', externalSessionId }
      }
      q = qoderQuery(lease, {
        prompt: prompt.stream,
        options: {
          ...qoderSessionOptions(request.cwd, request.resume, request.permissionMode, request.mcpExecution),
          ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
          abortController: controller
        }
      })
      const events = (async () => {
        for await (const message of q!) {
          const raw = message as unknown as Record<string, unknown>
          request.recordNative?.(typeof raw.type === 'string' ? raw.type : 'unknown', raw)
          const reported = typeof raw.session_id === 'string' && raw.session_id.trim() ? raw.session_id : undefined
          if (reported) adoptSessionId(reported)
          else if (!externalSessionId && requestedSessionId) adoptSessionId(requestedSessionId)
          for (const event of normalizeQoderMessage(message, ctx)) request.emit(qoderTrace(event))
        }
      })()
      let providerResult: ProviderRunResult
      try {
        const result = await q.reloadPlugins()
        if (!externalSessionId && requestedSessionId) adoptSessionId(requestedSessionId)
        onPluginsReloaded()
        const errorCount = Number(result.error_count ?? 0)
        const text = `插件已重载：${result.plugins.length} 个插件，${result.commands.length} 条命令${errorCount > 0 ? `，${errorCount} 个错误` : ''}`
        // A control answer, not model output: no model event, and the result says so, which
        // keeps this turn out of `.scry/records` (there is no canonical model turn to commit).
        request.emit(qoderTrace({
          id: newId(), runId: request.runId, ts: new Date().toISOString(),
          kind: 'harness', stage: 'result', text,
          isError: errorCount > 0,
          providerId: 'qoder', runtimeProvider: 'qoder_cli',
          providerCommand: { name: 'plugins reload', source: 'control', modelTurn: 'unobserved' },
          runtimeMetadata: { source: 'qoder_sdk_control', localCommand: '/plugins reload' }
        }))
        providerResult = {
          stopped,
          status: stopped ? 'interrupted' : errorCount > 0 ? 'failed' : 'completed',
          mcp: qoderMcpSnapshot(result.mcpServers)
        }
      } catch (error) {
        if (!stopped) throw error
        providerResult = { stopped: true, status: 'interrupted' }
      } finally {
        prompt.release()
        await q.close().catch(() => {})
        await events
        await lease.stop()
      }
      return { ...providerResult, externalSessionId }
    })()
    return {
      promise,
      interrupt: () => {
        stopped = true
        controller.abort()
        void q?.interrupt().catch(() => {})
      },
      forceKill: () => {
        signalProcessTree(lease?.identity ? Promise.resolve(lease.identity) : undefined, 'SIGKILL')
        void lease?.stop()
      },
      // lease 是本轮专属的 Qoder 守护进程：硬杀不会波及其他 run。
      forceKillScope: 'run_scoped',
      getExternalSessionId: () => externalSessionId,
      getProviderTurnId: () => undefined
}
}
