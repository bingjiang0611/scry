import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex-test/1', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'skills/list') {
    send({ id: message.id, result: { data: [{ cwd: '/repo', skills: [], errors: [] }] } })
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'openai' } })
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null, durationMs: 12 } } })
  } else if (message.id !== undefined) {
    send({ id: message.id, result: {} })
  }
})
