import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ProviderRunRequest } from './types'
import type { ProviderId } from '../../shared/provider'

export interface SmokeScenarioContext {
  providerId: ProviderId
  request: ProviderRunRequest
  startedAt: number
  isStopped: () => boolean
  questionSignal: AbortSignal
  composerProbe: boolean
  deferredNativeTurn: boolean
}

export async function runSmokePromptScenarios(ctx: SmokeScenarioContext): Promise<void> {
  const { providerId, request, startedAt, isStopped, questionSignal, composerProbe, deferredNativeTurn } = ctx
  if (composerProbe) {
    if (deferredNativeTurn) request.emit({ id: `${request.runId}:pending`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'harness', stage: 'init', text: `Awaiting native turn: ${request.prompt}` })
    if (!deferredNativeTurn) request.emit({ id: `${request.runId}:composer`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'model', stage: 'text', text: `Visible reply: ${request.prompt}` })
    // A controlled stop fixture waits for the actual interrupt, not a timing-dependent sleep.
    if (!request.prompt.startsWith('native composer complete ') && !isStopped()) {
      await new Promise<void>(resolve => questionSignal.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
  if (request.prompt === 'dock badge question smoke' || request.prompt === 'remote provider failure smoke') {
    request.emit({ id: `${request.runId}:assistant`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'model', stage: 'text', text: 'isolated fixture started' })
  }
  if (request.prompt === 'remote provider failure smoke') {
    request.emit({ id: `${request.runId}:result`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'harness', stage: 'result', text: 'fixture_provider_failure', isError: true, durationMs: Date.now() - startedAt })
    throw new Error('fixture_provider_failure')
  }
  if (request.prompt === 'llm performance smoke') {
    request.emit({ id: `${request.runId}:performance-text`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'model', stage: 'text_delta', text: 'main observer performance fixture' })
    if (!request.requestUserInput) throw new Error('Performance smoke requires requestUserInput')
    await request.requestUserInput({ runId: request.runId, questionId: `${request.runId}:performance`, providerId,
      questions: [{ header: 'Performance fixture', question: 'Keep this isolated run open?', options: [], multiSelect: false }]
    }, questionSignal)
  }
  if (request.prompt === 'concurrency trace live') {
    // Offline trace-volume fixture: the whole seed burst is emitted synchronously, before any
    // user interaction, so a run's event order never depends on timing.
    if (!request.requestUserInput) throw new Error('Concurrency trace fixture requires requestUserInput')
    for (let index = 1; index <= 1000; index++) {
      const label = String(index).padStart(4, '0')
      request.emit({ id: `${request.runId}:concurrency-trace:${label}`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'harness', stage: 'runtime:progress', text: `concurrency trace seed ${label}` })
    }
    request.emit({ id: `${request.runId}:concurrency-trace-ready`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'model', stage: 'text', text: 'concurrency trace ready' })
    await request.requestUserInput({ runId: request.runId, questionId: `${request.runId}:concurrency-trace`, providerId,
      questions: [{ header: 'Concurrency trace', question: 'Continue the concurrency trace fixture?', options: [], multiSelect: false }]
    }, questionSignal)
  }
  if (request.prompt === 'dock badge question smoke') {
    if (!request.requestUserInput) throw new Error('Question smoke requires requestUserInput')
    for (const step of [1, 2]) {
      if (isStopped()) break
      await request.requestUserInput({
        runId: request.runId,
        questionId: `${request.runId}:question:${step}`,
        providerId,
        questions: [{
          header: 'Dock badge',
          question: 'Continue the isolated badge smoke?',
          options: [{ label: 'Continue', description: 'Finish the fixture run' }],
          multiSelect: false
        }]
      }, questionSignal)
    }
  }
}

export async function runSmokePostToolScenarios(ctx: Pick<SmokeScenarioContext, 'providerId' | 'request' | 'isStopped' | 'questionSignal'>): Promise<void> {
  const { providerId, request, isStopped, questionSignal } = ctx
  // Side-chat fixtures exercise different paths: some write a file or wait for
  // an interaction, while others only emit fixture text.
  const sideChat = /^side chat ([a-z-]+)(?: (.*))?$/s.exec(request.prompt)
  if (sideChat) {
    const [, action, argument = ''] = sideChat
    const token = (argument || 'evidence').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40)
    const messageId = `${request.runId}:message`
    if (action === 'write') {
      if (!request.cwd) throw new Error('side chat write fixture requires a workspace')
      const file = `side-chat-${token}.txt`
      await writeFile(join(request.cwd, file), `${providerId} ${request.runId} ${token}\n`)
      request.emit({ id: `${request.runId}:side-chat-write`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'tool', stage: 'tool_result', tool: 'Write', toolUseId: `${request.runId}:write`,
        fileOp: 'write', filePath: file, text: `wrote ${file}` })
      request.emit({ id: `${request.runId}:side-chat-text`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: `${providerId} wrote ${file}` })
    } else if (action === 'ask') {
      request.emit({ id: `${request.runId}:side-chat-text`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: `${providerId} needs approval for ${token}` })
      if (!request.requestUserInput) throw new Error('Approval smoke requires requestUserInput')
      await request.requestUserInput({
        runId: request.runId, questionId: `${request.runId}:approval`, providerId, questionKind: 'permission',
        questions: [{ header: 'Approval fixture', question: `Allow the isolated ${providerId} fixture to continue?`,
          options: [{ label: 'Allow once', description: 'Finish the fixture run' }, { label: 'Deny', description: 'Stop here' }],
          multiSelect: false }]
      }, questionSignal)
      request.emit({ id: `${request.runId}:side-chat-approved`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: `${providerId} continued after approval` })
    } else if (action === 'fill') {
      // A tall assistant body, so an acceptance can scroll inside one page instead of
      // only at its edges; the text is emitted like any other fixture reply.
      const lines = Array.from({ length: 60 }, (_, line) => `${providerId} 正文第 ${line + 1} 行：回滚锚点需要真实的长正文。`)
      request.emit({ id: `${request.runId}:side-chat-fill`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: lines.join('\n') })
    } else if (action === 'hold') {
      request.emit({ id: `${request.runId}:side-chat-text`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: `${providerId} holding ${token}` })
      // A controlled hold waits for the real interrupt instead of a timing-dependent sleep.
      if (!isStopped()) await new Promise<void>(resolve => questionSignal.addEventListener('abort', () => resolve(), { once: true }))
    } else {
      request.emit({ id: `${request.runId}:side-chat-text`, runId: request.runId, ts: new Date().toISOString(),
        kind: 'model', stage: 'text_delta', messageId, text: `${providerId} side chat reply: ${argument}` })
    }
  }
  if (request.prompt === 'file links smoke') {
    if (!request.cwd) throw new Error('file-link fixture requires a workspace')
    const absolute = pathToFileURL(join(dirname(request.cwd), 'rotom-team/docs/NATIVE-DELIVERY.md')).href
    request.emit({
      id: `${request.runId}:files`, runId: request.runId, ts: new Date().toISOString(),
      kind: 'model', stage: 'text_delta', messageId: `${request.runId}:message`,
      text: `验收总表：\`rotom-team/docs/NATIVE-DELIVERY.md\`\n\n[encoded report](generated/2026-10-18%20AI%20%E5%AD%A6%E4%B9%A0%E8%B5%84%E6%BA%90%E6%8E%A8%E8%8D%90%E6%B8%85%E5%8D%95%E5%9B%9E%E6%A3%80.md) [absolute](${absolute}) [license](../LICENSE) [binary](../asset.custom) [outside](escaped.md) \`missing.md\`\n\n[interactive-mode.ts:1252](packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1252)\n\n\`packages/coding-agent/src/modes/interactive/interactive-mode.ts:1252:3\`\n\n截图留在 \`${join(request.cwd, 'screens')}/\`（\`remote-workspace.png\`、\`remote-hosts.png\`、\`remote-settings.png\`、\`asset.custom\`、\`fail.custom\`）。`
    })
  }
}
