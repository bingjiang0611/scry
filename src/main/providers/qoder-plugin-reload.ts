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
          abortController: controller
        }
      })
      const events = (async () => {
        for await (const message of q!) {
          const raw = message as unknown as Record<string, unknown>
          request.recordNative?.(typeof raw.type === 'string' ? raw.type : 'unknown', raw)
          if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
            externalSessionId = raw.session_id
            request.onExternalSessionId?.(raw.session_id)
          }
          for (const event of normalizeQoderMessage(message, ctx)) request.emit(qoderTrace(event))
        }
      })()
      let providerResult: ProviderRunResult
      try {
        const result = await q.reloadPlugins()
        onPluginsReloaded()
        const errorCount = Number(result.error_count ?? 0)
        const text = `插件已重载：${result.plugins.length} 个插件，${result.commands.length} 条命令${errorCount > 0 ? `，${errorCount} 个错误` : ''}`
        request.emit({
          id: newId(), runId: request.runId, ts: new Date().toISOString(),
          kind: 'model', stage: 'text', text,
          runtimeMetadata: { source: 'qoder_sdk_control', localCommand: '/plugins reload' }
        })
        request.emit(qoderTrace({
          id: newId(), runId: request.runId, ts: new Date().toISOString(),
          kind: 'harness', stage: 'result', text,
          isError: errorCount > 0,
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
