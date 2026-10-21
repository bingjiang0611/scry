// Synthetic codec peer only. It never loads a model, executes a tool or runs recorder hooks.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const root = process.env.SCRY_WIRE_CASE
const mode = process.env.SCRY_WIRE_MODE
const sessionId = '00000000-0000-4000-8000-000000000001'
const promptId = '00000000-0000-4000-8000-000000000002'
const toolId = 'fixture-tool-call'
const log = (event, data = {}) => fs.appendFileSync(path.join(root, 'wire.jsonl'), JSON.stringify({ event, ...data }) + '\n')
const send = data => process.stdout.write(JSON.stringify(data) + '\n')
const frame = data => ({ uuid: randomUUID(), session_id: sessionId, ...data })
let hookId, ended = false, watcher
const finish = error => {
  assert(!ended, 'duplicate terminal result')
  ended = true
  watcher?.close()
  send(frame({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: Boolean(error),
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, stop_reason: error ? null : 'end_turn',
    total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], ...(error ? { errors: [error] } : { result: 'synthetic complete' }) }))
  log('terminal', { error: error ?? null })
}
const emitContent = () => {
  send(frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic text' } } }))
  send(frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'synthetic thinking' } } }))
  send(frame({ type: 'assistant', parent_tool_use_id: null, message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'offline-fixture',
    content: [{ type: 'tool_use', id: toolId, name: 'FixtureTool', input: { synthetic: true } }], stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } } }))
  send(frame({ type: 'tool_progress', tool_use_id: toolId, tool_name: 'FixtureTool', parent_tool_use_id: null, elapsed_time_seconds: 0 }))
  send(frame({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'synthetic reply' }] } }))
  if (mode === 'complete') finish()
}
const handle = packet => {
  log('received', { packet })
  if (packet.type === 'control_request') {
    if (packet.request.subtype === 'initialize') {
      hookId = packet.request.hooks?.UserPromptSubmit?.[0]?.hookCallbackIds?.[0]
      assert.equal(typeof hookId, 'string')
      send({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: { commands: [], models: [], agents: [] } } })
      send(frame({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'offline-fixture',
        permissionMode: 'default', capabilities: {}, apiKeySource: 'none', claude_code_version: 'synthetic-transport', slash_commands: [], output_style: 'default' }))
    } else if (packet.request.subtype === 'interrupt') {
      assert.equal(mode, 'interrupt')
      // Register the filesystem gate BEFORE ACK, avoiding a lost release event.
      watcher = fs.watch(root, (_event, name) => {
        if (name !== 'release') return
        assert.equal(fs.readFileSync(path.join(root, 'release'), 'utf8'), 'release-after-ack\n')
        finish('synthetic interrupt after ACK')
      })
      send({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: {} } })
      log('interrupt-ack', { requestId: packet.request_id })
    } else throw new Error('Unexpected control request: ' + packet.request.subtype)
  } else if (packet.type === 'user') {
    assert.deepEqual(packet.message.content, [{ type: 'text', text: 'synthetic prompt with spaces\nand newline' }])
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
      finish('synthetic invalid callback rejected')
    } else {
      assert.equal(packet.response.subtype, 'success')
      assert.equal(packet.response.response.continue, true)
      log('hook-ack')
      emitContent()
    }
  } else throw new Error('Unexpected input frame: ' + packet.type)
}
async function main() {
  log('cli-start', { pid: process.pid, executable: process.execPath, argv: process.argv, cwd: process.cwd() })
  const code = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.SCRY_WIRE_PORT) })
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED') })
    socket.once('error', error => { socket.destroy(); resolve(error.code) })
  })
  log('cli-network', { code })
  assert.equal(code, 'EPERM', 'fake CLI must inherit OS network denial')
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', line => {
    try { handle(JSON.parse(line)) } catch (error) { log('protocol-error', { message: error.message }); process.stderr.write(error.stack + '\n'); process.exit(2) }
  })
  lines.once('close', () => { log('stdin-eof', { ended }); assert(ended, 'EOF before terminal evidence') })
}
process.on('SIGTERM', () => { log('signal', { signal: 'SIGTERM' }); process.exit(143) })
main().catch(error => { log('fatal', { message: error.message }); process.stderr.write(error.stack + '\n'); process.exit(2) })
