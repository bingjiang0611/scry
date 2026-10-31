import { forkSession, getSessionMessages } from '@qoder-ai/qoder-agent-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveRuntimeCliBin } from '../claude-locate'
import { extractUserText } from '../normalize'
import { createQoderCatalog } from './qoder-catalog'
import { createQoderControls } from './qoder-controls'
import { enrichQoderHistory } from './qoder-evidence'
import { qoderExecutable } from './qoder-launch'
import { readQoderMcpSnapshot, reauthenticateQoderMcp } from './qoder-mcp'
import { runQoderPluginReload } from './qoder-plugin-reload'
import { runQoder } from './qoder-run'
import { explainQoderSessionAccessError } from './qoder-shared'
import { qoderContinuationKey } from './host-continuation-identity'
import type { QoderHookFallbackState } from './qoder-hooks'
import { completedTranscriptTurnBoundary, isTranscriptUserPrompt } from './session-fork-boundary'
import { resolveQoderForkUserId } from './qoder-fork-identity'
import type { ProviderAdapter, ProviderRunRequest } from './types'

export function createQoderAdapter(homeDir = homedir()): ProviderAdapter {
  const hookFallback: QoderHookFallbackState = { observed: false }
  const controls = createQoderControls()
  const catalog = createQoderCatalog(controls)
  const executable = (): string | undefined =>
    process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  // A plugin reload replaces the native command/skill sources; drop the cached
  // catalog so the next read cannot serve pre-reload metadata.
  const reloaded = (): void => {
    catalog.dispose()
    controls.invalidate({ providerId: 'qoder' })
  }

  return {
    id: 'qoder',
    runtimeProvider: 'qoder_cli',
    historicalContext: true,
    continuationKey: (context) => qoderContinuationKey(context, homeDir, qoderExecutable()),
    describe: async () => {
      const path = executable()
      const fallbackError = hookFallback.error || controls.closeError()
      return {
        id: 'qoder',
        label: 'Qoder',
        runtimeProvider: 'qoder_cli',
        transport: 'Qoder Agent SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: fallbackError
          ? { state: 'degraded', transport: 'Qoder Agent SDK', lastError: fallbackError }
          : { state: !path ? 'unavailable' : hookFallback.observed ? 'ready' : 'unknown', transport: 'Qoder Agent SDK' }
      }
    },
    forkLastTurn: {
      async fork(request) {
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        }).catch(explainQoderSessionAccessError)
        const nativeIndex = messages.findIndex((message) =>
          typeof (message as { uuid?: unknown }).uuid === 'string' &&
          (message as { uuid: string }).uuid === request.replaceForkTurnId
        )
        const promptIndex = messages.findLastIndex((message) => {
          const payload = message.message && typeof message.message === 'object' && !Array.isArray(message.message)
            ? (message.message as { content?: unknown }).content
            : message.message
          return message.type === 'user' && message.parent_tool_use_id == null &&
            extractUserText(payload).trim() === request.originalPrompt.trim()
        })
        const index = nativeIndex >= 0 ? nativeIndex : promptIndex
        const boundary = index > 0 ? (messages[index - 1] as { uuid?: unknown }).uuid : undefined
        if (typeof boundary !== 'string' || !boundary) throw new Error('Qoder 会话无法定位待替换消息的前一边界')
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Edited branch'
        }).catch(explainQoderSessionAccessError)
        return { externalSessionId: forked.sessionId }
      }
    },
    forkSession: {
      async fork(request) {
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        }).catch(explainQoderSessionAccessError)
        const activeUserIds = new Set(messages.filter(isTranscriptUserPrompt).map((message) => message.uuid))
        // Older Scry archives copied promptId into forkTurnId. Never treat it as a UUID
        // or guess by prompt text; recover the exact native mapping when it is absent.
        const sourceUserId = activeUserIds.has(request.sourceForkTurnId)
          ? request.sourceForkTurnId
          : request.sourceForkTurnId === request.sourceProviderTurnId
            ? await resolveQoderForkUserId({
                projectsDir: join(process.env.QODER_CONFIG_DIR ||
                  join(process.env.QODER_CLI_HOME || homedir(), '.qoder'), 'projects'),
                sessionId: request.sourceSessionId,
                cwd: request.cwd,
                promptId: request.sourceProviderTurnId,
                activeUserIds
              }).catch(explainQoderSessionAccessError)
            : request.sourceForkTurnId
        const boundary = completedTranscriptTurnBoundary(messages, sourceUserId, 'Qoder')
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Scry branch'
        }).catch(explainQoderSessionAccessError)
        return { externalSessionId: forked.sessionId }
      }
    },
    run: (request: ProviderRunRequest) => {
      // `/plugins reload` never submits model input, so it has no receipt. A caller
      // that asks for a verifiable input must go through the normal path, where
      // HistoricalInput rejects the slash command before dispatch.
      if (!request.historicalContext && request.trackInputReceipt !== true &&
        /^\/plugins\s+reload\s*$/i.test(request.prompt)) {
        return runQoderPluginReload(request, () => reloaded())
      }
      return runQoder(request, { homeDir, hookFallback })
    },
    sessionEvidence: {
      async enrich(context, turns) {
        if (!context.externalSessionId) return turns
        try {
          const messages = await getSessionMessages(context.externalSessionId, {
            dir: context.cwd,
            includeSystemMessages: true
          })
          return enrichQoderHistory(turns, messages)
        } catch {
          return turns
        }
      }
    },
    mcp: {
      snapshot: (context, refresh = false, execution) => readQoderMcpSnapshot(homeDir, context, refresh, execution),
      reauthenticate: (context, targetId, execution, interaction) =>
        reauthenticateQoderMcp(context, targetId, execution, interaction)
    },
    invalidateContext: async (context) => {
      catalog.invalidate(context.cwd ?? '')
      await controls.invalidate(context)
    },
    skills: { list: (context) => catalog.skills(context) },
    commands: { list: (context) => catalog.commands(context) },
    runControls: { read: (context) => catalog.runControls(context) },
    dispose: async () => {
      catalog.dispose()
      await controls.dispose()
    }
  }
}

export { expandQoderProjectCommand } from './qoder-commands'
export {
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderProviderTurnIdFromLog
} from './qoder-hooks'
export { resolveQoderSdkExecutable } from './qoder-launch'
