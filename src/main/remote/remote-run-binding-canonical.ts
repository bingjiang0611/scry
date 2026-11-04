import type { AgentInputAttachment, AgentStartRequest } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import { traceEventToOutputChunk } from './trace-output'
const marker = (value: Record<string, unknown>): string => JSON.stringify(value)

import type { RemoteRunBindingDependencies, RemoteRunInput } from './remote-run-binding'

export async function startCanonicalRemoteRun(input: RemoteRunInput, deps: RemoteRunBindingDependencies, nextScryRunId: () => string): Promise<void> {
  const { runId: ledgerRunId, routing, progress, output, requestUserInput, stopSignal } = input
    const prompt = typeof routing.prompt === 'string' ? routing.prompt.trim() : ''
    if (prompt.length === 0) throw new Error('remote_run_missing_prompt')
    const scryRunId = nextScryRunId()
    const resume = typeof routing.resume === 'string' ? routing.resume.trim() : ''
    const routedAttachments = routing.attachments ?? []
    const attachments: AgentInputAttachment[] = routedAttachments
      .filter((item) => item.kind === 'image')
      .map((item) => ({ kind: 'image', name: item.name, mimeType: item.mimeType as AgentInputAttachment['mimeType'], dataBase64: item.dataBase64, size: item.size }))
    const textFiles = routedAttachments.filter((item) => item.kind === 'text')
    const providerPrompt = textFiles.length === 0 ? prompt : [prompt, textFiles.map((file) => {
      const content = Buffer.from(file.dataBase64, 'base64').toString('utf8')
      return `<scry_attached_file name=${JSON.stringify(file.name)} mime=${JSON.stringify(file.mimeType)}>\n${content}\n</scry_attached_file>`
    }).join('\n\n')].join('\n\n')
    const outputByMessageId = new Map<string, string>()
    let sawAssistantText = false
    const onTraceEvent = (ev: TraceEvent): void => {
      const chunk = traceEventToOutputChunk(ev)
      const messageId = typeof ev.messageId === 'string' ? ev.messageId : undefined
      const replaces = ev.runtimeMetadata?.replacesStreamedText === true
      if (replaces && messageId && ev.stage === 'text' && ev.text === '') outputByMessageId.delete(messageId)
      if (ev.stage === 'runtime:controls') progress(marker({ event: 'started', controls: ev.input }))
      if (ev.kind === 'harness' && ev.stage === 'result') {
        if (!ev.isError && !sawAssistantText && typeof ev.text === 'string' && ev.text.length > 0) {
          sawAssistantText = true
          output({ kind: 'output', text: ev.text })
        }
        progress(marker({ event: 'result', isError: Boolean(ev.isError), ...(typeof ev.tokensIn === 'number' ? { tokensIn: ev.tokensIn } : {}), ...(typeof ev.tokensOut === 'number' ? { tokensOut: ev.tokensOut } : {}), ...(typeof ev.costUsd === 'number' ? { costUsd: ev.costUsd } : {}) }))
      }
      if (!chunk) return
      let forwarded = chunk
      if (chunk.kind === 'output' && messageId) {
        const previous = outputByMessageId.get(messageId)
        if (replaces && previous !== undefined) {
          if (previous === chunk.text) return
          if (chunk.text.startsWith(previous)) forwarded = { ...chunk, text: chunk.text.slice(previous.length) }
          else if (typeof ev.runtimeMetadata?.genuineStreamDelta === 'string' && ev.runtimeMetadata.genuineStreamDelta.length > 0) forwarded = { ...chunk, text: ev.runtimeMetadata.genuineStreamDelta }
        }
        outputByMessageId.set(messageId, replaces ? chunk.text : ev.stage === 'text_delta' ? `${previous ?? ''}${chunk.text}` : chunk.text)
      }
      if (forwarded.text.length > 0) {
        if (forwarded.kind === 'output') sawAssistantText = true
        output(forwarded)
      }
    }
    progress(marker({ event: 'bound', ledgerRunId, scryRunId, providerId: routing.providerId, cwd: routing.cwd }))
    if (resume) progress(marker({ event: 'session', externalSessionId: resume, resumed: true }))
    try {
      const completion = await deps.startAppRun!({
        runId: scryRunId,
        ledgerRunId,
        request: {
          prompt, cwd: routing.cwd, providerId: routing.providerId as AgentStartRequest['providerId'],
          ...(routing.agentProfileId ? { agentProfileId: routing.agentProfileId } : {}),
          ...(resume ? { expectedExternalSessionId: resume } : {}), attachments,
          ...(routing.modelId ? { model: { id: routing.modelId, ...(routing.modelProviderId ? { providerId: routing.modelProviderId } : {}) } } : {}),
          ...(routing.effort ? { effort: routing.effort } : {}), ...(routing.permissionMode ? { permissionMode: routing.permissionMode } : {}),
          ...(routing.workspace ? { workspace: routing.workspace } : {})
        },
        ...(providerPrompt !== prompt ? { providerPrompt } : {}),
        stopSignal: stopSignal ?? new AbortController().signal,
        requestUserInput: async (question, signal) => {
          if (!requestUserInput) throw new Error('remote_interactive_input_unsupported')
          return requestUserInput(question, signal)
        },
        onTraceEvent,
        onSession: (externalSessionId) => progress(marker({ event: 'session', externalSessionId })),
        permissionModeOverride: deps.permissionModeOverride
      })
      if (completion.recording === 'failed') throw new Error(completion.error ?? 'remote_recording_failed')
      if (completion.status === 'failed') throw new Error(completion.error ?? 'provider_run_failed')
      progress(marker({ event: 'settled', status: completion.status }))
    } catch (error) {
      progress(marker({ event: 'settled', status: 'failed' }))
      throw error
    }
  }
