import readline from 'node:readline'
import { closeSync, existsSync, writeFileSync } from 'node:fs'

const input = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let pendingServerRequest
const mode = process.argv[2]
const marker = process.argv[3]

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'fail-initialize-once' && marker && !existsSync(marker)) {
      writeFileSync(marker, 'failed')
      send({ id: message.id, error: { code: -32000, message: 'initialize denied' } })
      return
    }
    if (mode === 'close-stdin-once' && marker && !existsSync(marker)) {
      writeFileSync(marker, 'closed')
      closeSync(0)
      setTimeout(() => send({ id: message.id, result: { userAgent: 'codex-test/1' } }), 300)
      setTimeout(() => process.exit(0), 1_500)
      return
    }
    send({ id: message.id, result: { userAgent: 'codex-test/1', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'skills/list') {
    send({ id: message.id, result: { data: [{ cwd: '/repo', skills: [], errors: [] }] } })
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'openai' } })
  } else if (message.method === 'turn/start' && message.params?.hang) {
    // Deliberately leave turn/start pending.
  } else if (message.method === 'turn/start' && message.params?.hangCompletion) {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    // Deliberately omit turn/completed while another request tears down this generation.
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    send({ method: 'item/agentMessage/delta', emittedAtMs: 1_234, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null, durationMs: 12 } } })
  } else if (message.method === 'test/serverRequest') {
    pendingServerRequest = message.id
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'pwd' } })
  } else if (message.method === 'test/hang') {
    // Deliberately leave the request pending so timeout teardown/restart can be verified.
  } else if (message.id === 'approval-1' && pendingServerRequest !== undefined) {
    send({ id: pendingServerRequest, result: { approval: message.result } })
    pendingServerRequest = undefined
  } else if (message.id !== undefined) {
    send({ id: message.id, result: {} })
  }
})
