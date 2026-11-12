// Fixture RPC script, first half. The two halves concatenate to one byte-identical program.
export const piFixtureSourceHead = `#!/usr/bin/env node
require('node:fs').appendFileSync(process.cwd() + '/fixture-starts', String(process.pid) + '\\n')
require('node:fs').writeFileSync(process.cwd() + '/fixture-argv.json', JSON.stringify(process.argv.slice(2)))
if (process.argv.includes('--approve') || process.argv.includes('--no-approve')) {
  process.stderr.write('Scry must not override Pi project trust')
  process.exit(64)
}
let buffer = ''
let leafId = 'active-leaf'
let sessionId = 'pi-session-1'
let model = { provider: 'test-provider', id: 'test-model' }
let thinkingLevel = 'high'
let entrySeq = 0
let promptMessage = ''
let acknowledgePrompt
const entries = [
  { type: 'message', id: 'active-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user' } },
  { type: 'message', id: 'active-leaf', parentId: 'active-user', timestamp: new Date().toISOString(), message: { role: 'assistant' } },
  { type: 'message', id: 'abandoned-user', parentId: 'active-leaf', timestamp: new Date().toISOString(), message: { role: 'user' } }
]
const sessionFile = process.cwd() + '/pi-session-1.jsonl'
const persistEntries = () => require('node:fs').writeFileSync(sessionFile, [
  { type: 'session', id: promptMessage === 'mismatched-header' ? 'wrong-native-session' : sessionId, cwd: process.cwd() }, ...entries
].map((entry) => JSON.stringify(entry)).join('\\n') + '\\n')
// This fixture starts with native conversation entries, so its session is already on disk.
persistEntries()
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (process.env.SCRY_HISTORY_READER_SNAPSHOT) require('node:fs').writeFileSync(process.cwd() + '/history-launch.json', JSON.stringify({ args: process.argv, snapshotId: process.env.SCRY_HISTORY_READER_SNAPSHOT }))
let finishStartupUi
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!raw) continue
    const command = JSON.parse(raw)
    require('node:fs').appendFileSync(process.cwd() + '/fixture-commands', JSON.stringify(command) + '\\n')
    const response = (data) => send({ type: 'response', id: command.id, command: command.type, success: true, ...(data ? { data } : {}) })
    if (command.type === 'extension_ui_response' && command.id === 'catalog-startup') {
      finishStartupUi(command)
      continue
    }
    if (command.type === 'get_state') {
      if (promptMessage === 'final-state-hang') {
        send({ type: 'extension_ui_request', id: 'final-state-wait', method: 'select', title: 'Final state', options: ['Continue'] })
        continue
      }
      if (require('node:fs').existsSync(process.cwd() + '/hold-startup')) {
        send({ type: 'extension_ui_request', id: 'startup-wait', method: 'select', title: 'Loading', options: ['Wait'] })
        continue
      }
      if (require('node:fs').existsSync(process.cwd() + '/small-window')) model.contextWindow = 8000
      const state = {
        model,
        thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionId,
        sessionFile,
        cwd: process.cwd()
      }
      if (promptMessage === 'stop-before-final-state') {
        require('node:fs').writeFileSync(process.cwd() + '/final-state-requested', '')
      }
      if (require('node:fs').existsSync(process.cwd() + '/startup-ui')) {
        const timeout = setTimeout(() => send({ type: 'response', id: command.id, command: command.type, success: false, error: 'Startup UI was not cancelled' }), 1000)
        finishStartupUi = (reply) => {
          clearTimeout(timeout)
          if (reply.cancelled === true && reply.value === undefined && reply.confirmed === undefined) response(state)
          else send({ type: 'response', id: command.id, command: command.type, success: false, error: 'Read-only probe must not approve setup' })
        }
        send({ type: 'extension_ui_request', id: 'catalog-startup', method: 'select', title: 'Optional setup', options: ['Open Settings'] })
        continue
      }
      response(state)
    }
    else if (command.type === 'set_model') {
      model = { provider: command.provider, id: command.modelId }
      // Model switches may reset thinking before the explicit effort selection is applied.
      thinkingLevel = 'off'
      response(model)
    }
    else if (command.type === 'set_thinking_level') {
      thinkingLevel = command.level
      response()
    }
    else if (command.type === 'get_available_models') {
      const models = () => response({ models: [{
        provider: 'openai-codex', id: 'test-model', name: 'Test Model', contextWindow: 200000,
        thinkingLevelMap: { off: null, high: 'high' }
      }] })
      // Intentionally never answer optional telemetry. Prompt and process shutdown must not depend on it.
      if (!require('node:fs').existsSync(process.cwd() + '/hold-model-query')) models()
    }
    else if (command.type === 'get_available_thinking_levels') response({ levels: ['off', 'high'] })
    else if (command.type === 'get_commands') response({ commands: [
      ...(process.env.SCRY_HISTORY_READER_SNAPSHOT && require('node:fs').existsSync(process.cwd() + '/history-ready')
        ? [{ name: 'scry_history_ready_' + process.env.SCRY_HISTORY_READER_SNAPSHOT.replaceAll('-', ''), source: 'extension' }] : []),
      { name: 'fixture-menu', description: 'Open an extension menu', source: 'extension' },
      {
        name: 'skill:review', description: 'Review code', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.pi/agent/skills/review/SKILL.md' }
      },
      {
        name: 'skill:rate-workflow', description: 'Run rate workflow', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.claude/skills/rate-workflow/SKILL.md' }
      }
    ] })
    else if (command.type === 'fork') {
      const target = entries.find((entry) => entry.id === command.entryId && entry.message?.role === 'user')
      if (!target) send({ type: 'response', id: command.id, command: command.type, success: false, error: 'invalid fork target' })
      else {
        sessionId = 'pi-session-forked'
        leafId = target.parentId
        response({ text: target.message.content ?? '', cancelled: false })
      }
    }
    else if (command.type === 'clone') {
      sessionId = 'pi-session-cloned'
      response({ cancelled: false })
    }
    else if (command.type === 'get_entries') {
      const start = command.since == null ? 0 : entries.findIndex((entry) => entry.id === command.since) + 1
      if (command.since != null && start === 0) {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'invalid cursor' })
      } else response({ entries: entries.slice(start), leafId })
    }
    else if (command.type === 'prompt') {
      if (command.message.startsWith('/scry_history_ready_')) {
        if (model.id !== 'changed-model') send({ type: 'extension_ui_request', method: 'notify', message: 'scry_history_ready:' + process.env.SCRY_HISTORY_READER_SNAPSHOT })
        else send({ type: 'extension_error', extensionPath: process.argv.at(-1), error: 'Fixture tool disabled after model selection' })
        response()
        continue
      }
      promptMessage = command.message
      if (require('node:fs').existsSync(process.cwd() + '/hold-model-query')) require('node:fs').writeFileSync(process.cwd() + '/prompt-received', '')
      if (command.message === '/fixture-menu') {
        acknowledgePrompt = response
        send({ type: 'extension_ui_request', id: 'menu-select', method: 'select', title: 'Menu', options: ['Edit'] })
        continue
      }
      if (command.message.startsWith('/fixture-menu question')) {
        acknowledgePrompt = response
        const preview = command.message.endsWith('question-preview') ? '\\n\\n--- 1. Continue preview ---\\n' + 'Preview content'.repeat(200) : ''
        send({ type: 'extension_ui_request', id: 'question-select', method: 'select', title: '[复现动作] Continue?' + preview, options: ['1. Continue', '2. Type something.'] })
        continue
      }
      if (command.message.startsWith('/fixture-menu batch')) {
        acknowledgePrompt = response
        const entry = { type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: command.message }] } }
        entries.push(entry)
        persistEntries()
        leafId = entry.id
        send({ type: 'tool_execution_start', toolCallId: 'batch-tool', toolName: 'ask_user_question', args: { questions: [
          { header: 'Goal', question: 'What matters?', multiSelect: false, options: [{ label: 'Control', description: 'Stay in control' }, { label: 'Speed', description: 'Finish sooner' }] },
          { header: 'Review', question: 'When to review?', multiSelect: false, options: [{ label: 'Now', description: 'Before continuing' }, { label: 'Later', description: 'At the end' }] }
        ] } })
        send({ type: 'extension_ui_request', id: 'batch-first', method: 'select', title: '[Goal] What matters?', options: ['1. Control — Stay in control', '2. Speed — Finish sooner', '3. Type something.'] })
        continue
      }
      if (command.message === '/fixture-menu status') {
        const message = { role: 'custom', customType: 'fixture-status', display: true, content: 'Custom command status' }
        send({ type: 'message_start', message })
        send({ type: 'message_end', message })
        entries.push({ type: 'custom_message', id: 'custom-' + (++entrySeq), parentId: leafId, ...message })
        persistEntries()
        leafId = entries.at(-1).id
        response()
        continue
      }
      if (command.message === '/fixture-menu error') {
        send({ type: 'extension_error', extensionPath: 'command:fixture-menu', event: 'command', error: 'menu failed' })
        response()
        continue
      }
      if (command.message === 'transport-exit') process.exit(17)
      if (command.message === 'preflight-reject') {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'preflight rejected' })
        continue
      }
      if (command.message !== 'no-entry' && command.message !== 'late-entry') {
        if (command.message === 'with-compact') {
          const compact = { type: 'compaction', id: 'compact-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString() }
          entries.push(compact)
          persistEntries()
          leafId = compact.id
        }
        const entry = {
          type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString(),
          message: { role: 'user', content: require('node:fs').existsSync(process.cwd() + '/persisted-user-content.json')
            ? JSON.parse(require('node:fs').readFileSync(process.cwd() + '/persisted-user-content.json', 'utf8'))
            : [
              { type: 'text', text: command.message === 'mismatched-entry' ? 'rewritten input' : command.message.startsWith('/skill:') ? 'expanded skill content' : command.message },
              ...(command.images ?? [])
            ] }
        }
        entries.push(entry)
        persistEntries()
        leafId = entry.id
      }
      if (command.message === 'late-prompt-ack' || command.message === 'late-entry') {
        acknowledgePrompt = response
        if (command.message === 'late-entry') response()
        send({ type: 'extension_ui_request', id: 'delayed-release', method: 'select', title: 'Release?', options: ['Continue'] })
        continue
      }
      response()
      if (['provider-fetch-failed', 'provider-http-413', 'provider-account-changed', 'provider-account-changed-transport'].includes(command.message)) {
        const payloadTooLarge = command.message === 'provider-http-413'
        const accountChanged = command.message.startsWith('provider-account-changed')
        const transportFailure = command.message === 'provider-fetch-failed' || command.message === 'provider-account-changed-transport'
        send({ type: 'message_start', message: { role: 'assistant' } })
        send({ type: 'message_end', message: {
          role: 'assistant', provider: 'openai-codex', model: 'test-model', stopReason: 'error',
          errorMessage: accountChanged ? 'Qoder: account_changed_start_new_session' : payloadTooLarge ? 'Qoder: http_413' : 'fetch failed', content: [],
          ...(transportFailure ? { diagnostics: [{ type: 'provider_transport_failure', error: { message: 'WebSocket error' } }] } : {}),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        } })
        send({ type: 'agent_end', willRetry: false })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message.startsWith('tool-boundary:')) {
        const scenario = command.message.slice('tool-boundary:'.length)
        send({ type: 'message_start', message: { role: 'assistant' } })
        send({ type: 'message_end', message: {
          role: 'assistant', provider: 'qoder', model: 'ultimate', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'goal-1', name: 'goal_complete', arguments: {} }],
          usage: { input: 10, output: 4, cost: { total: 0 } }
        } })
        send({ type: 'tool_execution_start', toolCallId: 'goal-1', toolName: 'goal_complete', args: {} })
        if (scenario !== 'missing-result') send({
          type: 'tool_execution_end', toolCallId: scenario === 'unrelated' ? 'child-goal' : 'goal-1',
          toolName: 'goal_complete', isError: false,
          result: {
            content: [{ type: 'text', text: scenario === 'approved' ? 'Goal complete: inspected evidence approved.' :`
