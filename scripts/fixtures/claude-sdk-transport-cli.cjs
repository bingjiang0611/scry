// Synthetic Provider peer: no model/tool execution. One mode calls the pinned real recorder CLI.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const root = process.env.SCRY_WIRE_CASE
const mode = process.env.SCRY_WIRE_MODE
const sessionId = '00000000-0000-4000-8000-000000000001'
const promptId = '00000000-0000-4000-8000-000000000002'
const toolId = 'fixture-tool-call'
const recorderCli = process.env.SCRY_CLI_PATH
const recorderCliHash = recorderCli && createHash('sha256').update(fs.readFileSync(recorderCli)).digest('hex')
const cap = 16 * 1024
const log = (event, data = {}) => fs.appendFileSync(path.join(root, 'wire.jsonl'), JSON.stringify({ event, ...data }) + '\n')
let activeRecorderChild
const runRecorderHook = (hookEvent, payload) => new Promise((resolve, reject) => {
  assert.equal(mode, 'recorder-complete')
  assert.equal(typeof recorderCli, 'string', 'Managed recorder CLI path missing')
  assert.equal(recorderCliHash, process.env.SCRY_WIRE_RECORDER_ENTRY_HASH)
  assert.equal(createHash('sha256').update(fs.readFileSync(recorderCli)).digest('hex'), recorderCliHash)
  assert.equal(process.env.SCRY_RECORDER_MANAGED, '1', 'Managed recorder environment missing')
  assert.equal(process.env.SCRY_RECORDER_COMMIT_HOOK, undefined, 'Custom commit callback leaked')
  const args = ['recorder', 'hook', '--provider', 'claude', '--event', hookEvent, '--workspace', process.cwd(), '--stdin', '--verbose', '--managed']
  const child = spawn(process.execPath, [recorderCli, ...args], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  activeRecorderChild = child
  const nativeHookId = `recorder-${hookEvent}-${child.pid}`
  send(frame({ type: 'system', subtype: 'hook_started', hook_id: nativeHookId, hook_name: 'Scry private recorder', hook_event: hookEvent }))
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-cap) })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-cap) })
  log('recorder-hook', { hookEvent, pid: child.pid, command: process.execPath, executable: recorderCli, executableHash: recorderCliHash, argv: child.spawnargs, cwd: process.cwd() })
  child.once('error', reject)
  child.once('close', (code, signal) => {
    activeRecorderChild = undefined
    log('recorder-hook-exit', { hookEvent, pid: child.pid, code, signal, stdout, stderr })
    try {
      assert.equal(code, 0)
      assert.equal(signal, null)
      const result = JSON.parse(stdout)
      send(frame({ type: 'system', subtype: 'hook_response', hook_id: nativeHookId, hook_name: 'Scry private recorder', hook_event: hookEvent,
        output: stdout, stdout, stderr, exit_code: code, outcome: 'success' }))
      resolve(result)
    } catch (error) { reject(error) }
  })
  child.stdin.end(JSON.stringify(payload))
})
const send = data => process.stdout.write(JSON.stringify(data) + '\n')
const frame = data => ({ uuid: randomUUID(), session_id: sessionId, ...data })
let hookId, ended = false, finishing = false, watcher
const finish = async error => {
  assert(!finishing && !ended, 'duplicate terminal result')
  finishing = true
  watcher?.close()
  if (mode === 'recorder-complete') {
    const result = await runRecorderHook('Stop', {
      hook_event_name: 'Stop', session_id: sessionId, prompt_id: promptId,
      transcript_path: path.join(root, 'synthetic-transcript.jsonl'), stop_hook_active: false,
      last_assistant_message: error ? undefined : 'synthetic complete'
    })
    assert.equal(result.status, 'pending')
  }
  ended = true
  send(frame({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: Boolean(error),
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, stop_reason: error ? null : 'end_turn',
    total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], ...(error ? { errors: [error] } : { result: 'synthetic complete' }) }))
  log('terminal', { error: error ?? null })
}
const emitContent = async () => {
  send(frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic text' } } }))
  send(frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'synthetic thinking' } } }))
  send(frame({ type: 'assistant', parent_tool_use_id: null, message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'offline-fixture',
    content: [{ type: 'tool_use', id: toolId, name: 'FixtureTool', input: { synthetic: true } }], stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } } }))
  send(frame({ type: 'tool_progress', tool_use_id: toolId, tool_name: 'FixtureTool', parent_tool_use_id: null, elapsed_time_seconds: 0 }))
  send(frame({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'synthetic reply' }] } }))
  if (mode === 'complete' || mode === 'runner-complete' || mode === 'runner-plain' || mode === 'recorder-complete') await finish()
}
const handle = async packet => {
  log('received', { packet })
  if (packet.type === 'control_request') {
    if (packet.request.subtype === 'initialize') {
      hookId = packet.request.hooks?.UserPromptSubmit?.[0]?.hookCallbackIds?.[0]
      assert.equal(typeof hookId, 'string')
      send({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: { commands: [], models: [], agents: [] } } })
      send(frame({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'offline-fixture',
        permissionMode: 'default', capabilities: {}, apiKeySource: 'none', claude_code_version: 'synthetic-transport', slash_commands: [], output_style: 'default' }))
    } else if (packet.request.subtype === 'interrupt') {
      assert(mode === 'interrupt' || mode === 'runner-interrupt')
      // Register the filesystem gate BEFORE ACK, avoiding a lost release event.
      watcher = fs.watch(root, (_event, name) => {
        if (name !== 'release') return
        assert.equal(fs.readFileSync(path.join(root, 'release'), 'utf8'), 'release-after-ack\n')
        void finish('synthetic interrupt after ACK').catch(error => { log('protocol-error', { message: error.message }); process.stderr.write(error.stack + '\n'); process.exit(2) })
      })
      send({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: {} } })
      log('interrupt-ack', { requestId: packet.request_id })
    } else throw new Error('Unexpected control request: ' + packet.request.subtype)
  } else if (packet.type === 'user') {
    assert.deepEqual(packet.message.content, [{ type: 'text', text: 'synthetic prompt with spaces\nand newline' }])
    if (mode === 'recorder-complete') {
      const result = await runRecorderHook('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: process.cwd(),
        transcript_path: path.join(root, 'synthetic-transcript.jsonl'), prompt: packet.message.content[0].text, prompt_id: promptId
      })
      assert.equal(result.status, 'started')
    }
    send({ type: 'control_request', request_id: 'fixture-hook-request', request: { subtype: 'hook_callback',
      callback_id: mode === 'negative' ? 'unregistered-fixture-hook' : hookId,
      input: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: process.cwd(), transcript_path: path.join(root, 'synthetic-transcript.jsonl'),
        prompt: packet.message.content[0].text, prompt_id: promptId } } })
  } else if (packet.type === 'control_response') {
    assert.equal(packet.response.request_id, 'fixture-hook-request')
    if (mode === 'negative') {
      assert.equal(packet.response.subtype, 'error')
      assert.match(packet.response.error, /No hook callback found/)
      log('negative-rejected')
      await finish('synthetic invalid callback rejected')
    } else {
      assert.equal(packet.response.subtype, 'success')
      assert.equal(packet.response.response.continue, true)
      log('hook-ack')
      await emitContent()
    }
  } else throw new Error('Unexpected input frame: ' + packet.type)
}
async function main() {
  // Hold the child alive until the outside owner has obtained its OS birth.
  // Install before publishing cli-start so a fast owner cannot lose the ACK.
  const registered = new Promise(resolve => {
    const accept = () => {
      const file = path.join(root, 'fake-registered')
      if (!fs.existsSync(file)) return
      assert.equal(fs.readFileSync(file, 'utf8'), 'registered\n')
      registrationWatcher.close()
      resolve()
    }
    const registrationWatcher = fs.watch(root, accept)
    accept()
  })
  log('cli-start', { pid: process.pid, executable: process.execPath, argv: process.argv, cwd: process.cwd() })
  await registered
  const code = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.SCRY_WIRE_PORT) })
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED') })
    socket.once('error', error => { socket.destroy(); resolve(error.code) })
  })
  log('cli-network', { code })
  assert.equal(code, 'EPERM', 'fake CLI must inherit OS network denial')
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', line => {
    void Promise.resolve().then(() => handle(JSON.parse(line))).catch(error => { log('protocol-error', { message: error.message }); process.stderr.write(error.stack + '\n'); process.exit(2) })
  })
  lines.once('close', () => { log('stdin-eof', { ended }); assert(ended, 'EOF before terminal evidence') })
}
process.on('SIGTERM', () => {
  log('signal', { signal: 'SIGTERM' })
  const child = activeRecorderChild
  if (child && child.exitCode === null && child.signalCode === null) {
    child.once('close', () => process.exit(143))
    child.kill('SIGTERM') // Only the still-owned CLI handle; never a guessed PID/group.
  } else process.exit(143)
})
process.on('exit', code => { log('cli-exit', { code }) })
main().catch(error => { log('fatal', { message: error.message }); process.stderr.write(error.stack + '\n'); process.exit(2) })
