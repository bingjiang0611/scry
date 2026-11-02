import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { ProviderContext } from '../../shared/provider'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { runtimeCliEnv } from '../claude-locate'
import { HistoricalInput } from './historical-input'
import { emitOpenCodeEvent, emitOpenCodeHookEvents } from './opencode-events'
import { abortableSseSleep, normalizeOpenCodeRunError, unwrap } from './opencode-errors'
import { handleOpenCodePermission, handleOpenCodeQuestion, openCodePermissionRules } from './opencode-permissions'
import { openCodeModelContextWindows } from './opencode-controls'
import { openCodeEventType } from './opencode-records'
import { openCodeHookTraceCursor, readOpenCodeHookTrace } from './opencode-server'
import type { OpenCodeServerPool } from './opencode-server-pool'
import { publishOpenCodeTurn } from './opencode-turn-result'
import { openCodeContinuationKey, type OpenCodeIdentityOptions } from './host-continuation-identity'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

export interface OpenCodeRunDependencies {
  pool: OpenCodeServerPool
  /** Inputs of the native resume identity; re-derived here before dispatch. */
  identity: OpenCodeIdentityOptions
}

export function runOpenCode(request: ProviderRunRequest, deps: OpenCodeRunDependencies): ProviderRunHandle {
  const history = new HistoricalInput(request)
  let externalSessionId = request.resume
let providerTurnId: string | undefined
let recordingFailure: { message: string } | undefined
let stopped = false
let forceKilled = false
let stopConfirmation: Promise<boolean> | undefined
let abortDispatched = false
let client: OpencodeClient | undefined
const permissionController = new AbortController()
const requestController = new AbortController()
const eventController = new AbortController()
const context: ProviderContext = { providerId: 'opencode', cwd: request.cwd, externalSessionId }
// A run-scoped lease keeps the shared server alive; the server itself is per cwd.
const lease = deps.pool.lease(request.cwd)
const promise: Promise<ProviderRunResult> = (async () => {
  // A refused identity never touches the shared server, so it must not be recorded
  // as a transport failure for this workspace.
  let identityVerified = !request.expectedContinuationKey
  try {
    if (request.expectedContinuationKey) {
      // Re-derive the native resume identity here: settings can change between the
      // consumer's decision and the actual dispatch. Nothing has been leased yet.
      const actual = await openCodeContinuationKey(
        { providerId: 'opencode', cwd: request.cwd, agentProfileId: request.agentProfileId },
        deps.identity
      )
      if (actual !== request.expectedContinuationKey) throw new Error('OpenCode 接续身份已变化，输入未投递')
      identityVerified = true
    }
    if (stopped) return { externalSessionId, providerTurnId, stopped, status: 'interrupted' }
    if (!request.cwd) throw new Error('OpenCode 需要工作目录')
    const server = await deps.pool.serverFor(context, request.mcpExecution, request.openCodePluginTrust)
    client = server.client
    const modelRequest = client.v2?.model?.list?.({ location: { directory: request.cwd } })
    const modelContextPromise = modelRequest
      ? Promise.race([
          unwrap<{ data?: unknown[] }>(modelRequest, 'model.list')
            .then((response) => openCodeModelContextWindows(response.data ?? []))
            .catch(() => new Map<string, number>()),
          new Promise<Map<string, number>>((resolve) => {
            const timer = setTimeout(() => resolve(new Map()), 2_000)
            timer.unref?.()
          })
        ])
      : Promise.resolve(new Map<string, number>())
    if (stopped) return { externalSessionId, providerTurnId, stopped, status: 'interrupted' }
    const permission = openCodePermissionRules(request.permissionMode)
    const model = request.model
      ? {
          providerID: request.model.providerId ?? '',
          modelID: request.model.id
        }
      : undefined
    if (model && !model.providerID) throw new Error('OpenCode 模型缺少 providerId')
    // Final submitted text: legacy slash commands stay on the native command path, so a
    // managed prefix that would be dropped or altered is rejected before any dispatch.
    const slash = request.prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const outgoingText = history.text(request.prompt)
    if (!externalSessionId) {
      const session = await unwrap<{ id: string }>(client.session.create({
        directory: request.cwd,
        permission,
        ...(model ? { model: { id: model.modelID, providerID: model.providerID, variant: request.effort } } : {})
      }), 'session.create')
      externalSessionId = session.id
      request.onExternalSessionId?.(session.id)
    } else {
      await unwrap(
        client.session.update({ sessionID: externalSessionId, directory: request.cwd, permission }),
        'session.update'
      )
    }
    history.verifySession(externalSessionId!)
    if (stopped) {
      abortDispatched = true
      const aborted = await unwrap<boolean>(
        client.session.abort({ sessionID: externalSessionId, directory: request.cwd }),
        'session.abort'
      )
      if (aborted !== true) throw new Error('OpenCode did not confirm session abort')
      return { externalSessionId, providerTurnId, stopped, status: 'interrupted' }
    }
    if (request.managedRecorder) {
      if (!request.cwd || !request.managedRecorderIdentity) {
        throw new Error('OpenCode managed recorder 缺少受信任轮次身份')
      }
      const opened = await handleRecorderHook({
        provider: 'opencode',
        event: 'chat.message',
        workspace: request.cwd,
        managed: true,
        env: {
          ...runtimeCliEnv(undefined, { providerId: 'opencode' }),
          SCRY_MANAGED_RUN_ID: request.managedRecorderIdentity.runId,
          SCRY_MANAGED_PROMPT_HASH: request.managedRecorderIdentity.promptHash
        },
        payload: {
          session_id: externalSessionId,
          prompt: request.prompt,
          timestamp: new Date().toISOString()
        }
      })
      if (opened.status !== 'started' && opened.status !== 'duplicate') {
        throw new Error(`OpenCode managed recorder 无法建立轮次身份：${opened.reason ?? opened.status}`)
      }
    }
    const hookTracePath = server.hookTracePath
    const hookTraceOffset = await openCodeHookTraceCursor(hookTracePath)
    const eventOptions = {
      signal: eventController.signal,
      // The generated SDK does not expose sseSleepFn in this method's type,
      // but its runtime forwards it to createSseClient. This makes abort
      // interrupt retry backoff instead of waiting up to 30 seconds.
      sseSleepFn: abortableSseSleep(eventController.signal)
    } as unknown as Parameters<typeof client.event.subscribe>[1]
    const subscription = await client.event.subscribe({ directory: request.cwd }, eventOptions)
    const stream = subscription.stream as AsyncGenerator<unknown>
    let observationError: unknown
    const events = (async () => {
      try {
        for await (const event of stream) {
          request.recordNative?.(openCodeEventType(event), event)
          if (await handleOpenCodePermission(request, client!, event, externalSessionId!, permissionController.signal)) continue
          if (await handleOpenCodeQuestion(request, client!, event, externalSessionId!, permissionController.signal)) continue
          emitOpenCodeEvent(request, event, externalSessionId!)
        }
      } catch (error) {
        if (!stopped && !eventController.signal.aborted) observationError = error
      }
    })()
    if (stopped) {
      eventController.abort()
      await events
      return { externalSessionId, providerTurnId, stopped, status: 'interrupted' }
    }
    let response: { info: Record<string, unknown>; parts: unknown[] }
    let responseError: unknown
    if (!slash) {
      // A native command carries its own text, so only the prompt path has a verifiable input.
      history.validateBudget(request.model
        ? (await modelContextPromise).get(`${model!.providerID}\0${model!.modelID}`)
        : undefined)
      history.attempting(outgoingText)
    }
    try {
      response = slash
        ? await unwrap(client.session.command({
            sessionID: externalSessionId,
            directory: request.cwd,
            command: slash[1],
            arguments: slash[2] ?? '',
            ...(model ? {
              model: `${model.providerID}/${model.modelID}`,
              variant: request.effort
            } : {})
          }, { signal: requestController.signal }), 'session.command')
        : await unwrap(client.session.prompt({
            sessionID: externalSessionId,
            directory: request.cwd,
            ...(model ? { model, variant: request.effort } : {}),
            parts: [
              { type: 'text', text: outgoingText },
              ...request.attachments.map((attachment) => ({
                type: 'file' as const,
                mime: attachment.mimeType,
                filename: attachment.name,
                url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
              }))
            ]
          }, { signal: requestController.signal }), 'session.prompt')
    } catch (error) {
      responseError = error
    } finally {
      eventController.abort()
      await events
      if (hookTracePath) {
        try {
          emitOpenCodeHookEvents(
            request,
            await readOpenCodeHookTrace(hookTracePath, hookTraceOffset),
            externalSessionId!,
            hookTracePath
          )
        } catch (error) {
          observationError ??= error
        }
      }
    }
    if (responseError != null) throw responseError
    const published = await publishOpenCodeTurn({
      request,
      client,
      externalSessionId: externalSessionId!,
      response: response!,
      modelContext: modelContextPromise,
      outgoingText,
      history,
      observationError,
      publish: (state) => {
        providerTurnId = state.providerTurnId
        recordingFailure = state.recordingFailure
      }
    })
    providerTurnId = published.providerTurnId
    recordingFailure = published.recordingFailure
    deps.pool.recordOk()
    return {
      externalSessionId,
      providerTurnId,
      stopped: published.stopped,
      status: published.status,
      recordingFailure
    }
  } catch (error) {
    permissionController.abort()
    requestController.abort()
    eventController.abort()
    if (stopped && (forceKilled || await stopConfirmation)) {
      return { externalSessionId, providerTurnId, stopped, status: 'interrupted' }
    }
    if (!identityVerified) throw error
    if (client && externalSessionId && !abortDispatched) {
      abortDispatched = true
      await client.session.abort({ sessionID: externalSessionId, directory: request.cwd }).catch(() => {})
    }
    const normalized = normalizeOpenCodeRunError(error, request.cwd, deps.pool.diagnosticHandle(request.cwd))
    deps.pool.recordFailure(normalized)
    throw normalized
  } finally {
    lease?.release()
  }
})()
const interrupt = (): void => {
  stopped = true
  permissionController.abort()
  // Keep the accepted request owned until OpenCode answers or its shared transport fails.
  // Aborting only the local fetch erases the native outcome and can report interruption while
  // the Agent is still running (or has already completed).
  if (client && externalSessionId && !stopConfirmation) {
    abortDispatched = true
    stopConfirmation = unwrap<boolean>(
      client.session.abort({ sessionID: externalSessionId, directory: request.cwd }),
      'session.abort'
    ).then((confirmed) => confirmed === true, () => false)
  }
}
return {
  promise,
  interrupt,
  forceKill: () => {
    forceKilled = true
    stopped = true
    permissionController.abort()
    requestController.abort()
    eventController.abort()
    lease?.forceClose()
  },
  // OpenCode server 按 cwd 复用（pool 计数租约）：forceClose() 会终止整个
  // server 及其上其他并发 run。
  forceKillScope: 'shared_transport',
  getExternalSessionId: () => externalSessionId,
  getProviderTurnId: () => providerTurnId,
  getRecordingFailure: () => recordingFailure,
  getInputReceipt: () => history.snapshot()
  }
}
