import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_JSON_BYTES = 64 * 1024
const MAX_ASSISTANT_BYTES = 256 * 1024

function debug(message) {
  if (process.env.SCRY_RECORDER_DEBUG === '1') process.stderr.write(`[scry-pi] ${message}\n`)
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

function boundedJson(value) {
  try {
    const source = JSON.stringify(value)
    if (Buffer.byteLength(source) <= MAX_JSON_BYTES) return value
    return { truncated: true, bytes: Buffer.byteLength(source), preview: source.slice(0, 4_000) }
  } catch {
    return { unavailable: true }
  }
}

function boundedText(value, limit = MAX_ASSISTANT_BYTES) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text) <= limit) return text
  return Buffer.from(text).subarray(0, limit).toString('utf8')
}

function assistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0, cost_usd: 0 }
}

function addUsage(total, message) {
  const usage = message && typeof message.usage === 'object' ? message.usage : {}
  const cost = usage && typeof usage.cost === 'object' ? usage.cost : {}
  const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning, cost.total]
  if (!fields.some((value) => typeof value === 'number' && Number.isFinite(value))) return false
  total.input_tokens += Number(usage.input) || 0
  total.output_tokens += Number(usage.output) || 0
  total.cache_read_input_tokens += Number(usage.cacheRead) || 0
  total.cache_creation_input_tokens += Number(usage.cacheWrite) || 0
  total.reasoning_tokens += Number(usage.reasoning) || 0
  total.cost_usd += Number(cost.total) || 0
  return true
}

function executable() {
  const configured = process.env.SCRY_CLI_PATH
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !existsSync(configured)) {
      debug('configured SCRY_CLI_PATH is unavailable; refusing PATH fallback')
      return undefined
    }
    try { return realpathSync(configured) } catch {
      debug('configured SCRY_CLI_PATH cannot be resolved; refusing PATH fallback')
      return undefined
    }
  }
  const candidates = [
    join(homedir(), '.local', 'bin', 'scry'),
    ...String(process.env.PATH || '').split(':').filter(Boolean).map((directory) => join(directory, 'scry')),
  ]
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue
    try { return realpathSync(candidate) } catch {}
  }
  return undefined
}

function socketTimeoutMs(event) {
  const configured = Number(process.env.SCRY_PI_SOCKET_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured >= 10 && configured <= 120_000) return Math.floor(configured)
  return event === 'UserPromptSubmit' || event === 'Stop' ? 12_000 : 2_000
}

function sendSocket(workspace, event, payload) {
  const socketPath = process.env.SCRY_RECORDER_SOCKET || join(workspace, '.scry', 'recorder-v1.sock')
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request({
      socketPath,
      path: '/v1/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Scry-Protocol': '1',
        'X-Scry-Provider': 'pi',
        'X-Scry-Event': event,
      },
    }, (response) => {
      let output = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { if (output.length < 64 * 1024) output += chunk })
      response.on('end', () => {
        try { finish(response.statusCode === 200 && JSON.parse(output).ok === true) } catch { finish(false) }
      })
    })
    req.setTimeout(socketTimeoutMs(event), () => {
      req.destroy()
      // A connected socket proves only transport dispatch, not that the daemon validated and
      // durably recorded the event. Fall back to the idempotent direct path unless it ACKs.
      finish(false)
    })
    req.on('error', () => finish(false))
    req.end(body)
  })
}

function sendDirect(workspace, event, payload) {
  const scry = executable()
  if (!scry) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(scry, [
      'recorder', 'hook', '--provider', 'pi', '--event', event,
      '--workspace', workspace, '--stdin', '--quiet',
      ...(process.env.SCRY_RECORDER_TRANSPORT === 'direct' ? [] : ['--start-daemon']),
    ], { cwd: workspace, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { if (stderr.length < 4_000) stderr += chunk.toString() })
    child.stdin.on('error', () => finish(false))
    child.on('error', () => finish(false))
    child.on('close', (code) => {
      if (code !== 0) debug(`hook ${event} exited ${String(code)} ${stderr.trim()}`)
      finish(code === 0)
    })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      debug(`hook ${event} timed out`)
      finish(false)
    }, 25_000)
    child.stdin.end(JSON.stringify(payload))
  })
}

async function deliver(workspace, event, payload) {
  if (process.env.SCRY_RECORDER_TRANSPORT !== 'direct' && await sendSocket(workspace, event, payload)) return
  await sendDirect(workspace, event, payload)
}

export default function scryPiRecorder(pi) {
  let active
  let queue = Promise.resolve()
  let responseStartedAt
  const enqueue = (workspace, event, payload) => {
    queue = queue.then(() => deliver(workspace, event, payload)).catch((error) => debug(String(error)))
    return queue
  }

  pi.on('before_agent_start', async (event, ctx) => {
    responseStartedAt = undefined
    const sessionId = ctx.sessionManager.getSessionId()
    const providerTurnId = ctx.sessionManager.getLeafId() || randomUUID()
    active = {
      workspace: ctx.cwd,
      sessionId,
      providerTurnId,
      assistant: [],
      usage: emptyUsage(),
      usageObserved: false,
      modelSegments: [],
      startedAt: new Date().toISOString(),
      settled: false,
    }
    await enqueue(ctx.cwd, 'UserPromptSubmit', {
      session_id: sessionId,
      promptId: providerTurnId,
      prompt: event.prompt,
      timestamp: active.startedAt,
    })
  })

  pi.on('message_start', (event) => {
    const message = event.message
    if (!active || !message || message.role !== 'assistant') return
    responseStartedAt = Date.now()
  })

  pi.on('message_end', (event) => {
    const message = event.message
    if (!active || !message || message.role !== 'assistant') return
    const text = assistantText(message)
    if (text) active.assistant.push(text)
    active.usageObserved = addUsage(active.usage, message) || active.usageObserved
    const id = message.responseId || message.id || randomUUID()
    const completedAtMs = Date.now()
    const startedAtMs = responseStartedAt ?? completedAtMs
    active.modelSegments.push({
      response_id: id,
      completed_at: new Date(completedAtMs).toISOString(),
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
    })
    responseStartedAt = undefined
  })

  pi.on('tool_execution_start', async (event) => {
    if (!active) return
    await enqueue(active.workspace, `PreToolUse:${event.toolName}`, {
      session_id: active.sessionId,
      promptId: active.providerTurnId,
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: boundedJson(event.args),
      timestamp: new Date().toISOString(),
    })
  })

  pi.on('tool_execution_end', async (event) => {
    if (!active) return
    await enqueue(active.workspace, event.isError ? `PostToolUseFailure:${event.toolName}` : `PostToolUse:${event.toolName}`, {
      session_id: active.sessionId,
      promptId: active.providerTurnId,
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_response: boundedJson(event.result),
      ...(event.isError ? { error: true } : {}),
      timestamp: new Date().toISOString(),
    })
  })

  pi.on('agent_settled', async () => {
    const turn = active
    if (!turn || turn.settled) return
    turn.settled = true
    await enqueue(turn.workspace, 'Stop', {
      session_id: turn.sessionId,
      promptId: turn.providerTurnId,
      assistant_response: boundedText(turn.assistant.join('\n')),
      ...(turn.usageObserved ? { usage: turn.usage } : {}),
      model_segments: turn.modelSegments,
      status: 'completed',
      timestamp: new Date().toISOString(),
    })
    if (active === turn) active = undefined
  })

  pi.on('session_shutdown', async () => {
    const turn = active
    if (turn && !turn.settled) {
      turn.settled = true
      await enqueue(turn.workspace, 'Stop', {
        session_id: turn.sessionId,
        promptId: turn.providerTurnId,
        assistant_response: boundedText(turn.assistant.join('\n')),
        ...(turn.usageObserved ? { usage: turn.usage } : {}),
        model_segments: turn.modelSegments,
        status: 'interrupted',
        timestamp: new Date().toISOString(),
      })
    }
    await queue
  })
}
