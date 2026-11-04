import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_JSON_BYTES = 64 * 1024
const MAX_ASSISTANT_BYTES = 256 * 1024
// A tool event stays below the daemon's 8 MiB request limit, including metadata.
const MAX_TOOL_BYTES = 4 * 1024 * 1024

let sigintHandler
let sigintFlush
let sigintFlushing = false

function armSigint(flush) {
  sigintFlush = flush
  if (sigintHandler) return
  sigintHandler = () => {
    if (sigintFlushing) {
      const handler = sigintHandler
      sigintHandler = undefined
      sigintFlush = undefined
      if (handler) process.removeListener('SIGINT', handler)
      process.kill(process.pid, 'SIGINT')
      return
    }
    const action = sigintFlush
    const handler = sigintHandler
    sigintFlush = undefined
    if (!action) {
      sigintHandler = undefined
      if (handler) process.removeListener('SIGINT', handler)
      process.kill(process.pid, 'SIGINT')
      return
    }
    // Pi loads signal-exit. Keep this listener installed for the whole first signal
    // emission; removing it synchronously would make signal-exit the sole listener,
    // and it would re-raise SIGINT before the asynchronous terminal delivery finishes.
    sigintFlushing = true
    void action().finally(() => {
      if (sigintHandler === handler) sigintHandler = undefined
      if (handler) process.removeListener('SIGINT', handler)
      sigintFlushing = false
      process.kill(process.pid, 'SIGINT')
    })
  }
  process.prependListener('SIGINT', sigintHandler)
}

function disarmSigint(flush) {
  if (sigintFlush !== flush) return
  sigintFlush = undefined
  if (sigintFlushing) return
  const handler = sigintHandler
  sigintHandler = undefined
  if (handler) process.removeListener('SIGINT', handler)
}

function debug(message) {
  if (process.env.SCRY_RECORDER_DEBUG === '1') process.stderr.write(`[scry-pi] ${message}\n`)
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

function utf8Prefix(text, limit) {
  const source = Buffer.from(text)
  if (source.byteLength <= limit) return text
  let end = limit
  while (end > Math.max(0, limit - 4)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(source.subarray(0, end)) } catch { end-- }
  }
  return source.subarray(0, end).toString('utf8')
}

function limitation(fields) {
  const captures = Object.fromEntries(Object.entries(fields)
    .filter(([, result]) => result?.capture)
    .map(([field, result]) => [field, result.capture]))
  return Object.keys(captures).length
    ? { scry_capture: { schemaVersion: 1, fields: captures } } : {}
}

function boundedJson(value) {
  // Preserve native tool bodies up to the transport budget; CAS precedes previews.
  try {
    const source = JSON.stringify(value)
    const bytes = Buffer.byteLength(source)
    if (bytes <= MAX_TOOL_BYTES) return { value }
    const preview = utf8Prefix(source, 4_000)
    return {
      value: { truncated: true, bytes, preview },
      capture: { status: 'partial', reason: 'byte_limit', originalBytes: bytes, retainedBytes: Buffer.byteLength(preview) }
    }
  } catch {
    return {
      value: { unavailable: true },
      capture: { status: 'unavailable', reason: 'serialization_error' }
    }
  }
}

function boundedText(value, limit = MAX_ASSISTANT_BYTES) {
  const text = String(value ?? '')
  const bytes = Buffer.byteLength(text)
  if (bytes <= limit) return { value: text }
  const retained = utf8Prefix(text, limit)
  return {
    value: retained,
    capture: { status: 'partial', reason: 'byte_limit', originalBytes: bytes, retainedBytes: Buffer.byteLength(retained) }
  }
}

function assistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function emptyUsage() {
  return {}
}

function addUsage(total, message) {
  const usage = message && typeof message.usage === 'object' ? message.usage : {}
  const cost = usage && typeof usage.cost === 'object' ? usage.cost : {}
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning, cost.total]
  const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (numeric.length === 0) return false
  // Pi reports an SDK-fetch failure as an all-zero usage object. It proves neither
  // zero spend nor zero reasoning, so it must not turn an unavailable snapshot into
  // an exact zero. Real partial values remain admissible.
  const failed = message?.stopReason === 'error' || message?.stopReason === 'aborted'
  if (failed && numeric.every((value) => value === 0)) return false
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] || 0) + value
  }
  add('input_tokens', usage.input)
  add('output_tokens', usage.output)
  add('cache_read_input_tokens', usage.cacheRead)
  add('cache_creation_input_tokens', usage.cacheWrite)
  add('reasoning_tokens', usage.reasoning)
  add('cost_usd', cost.total)
  return true
}

function resolveExecutable(candidate, source) {
  if (!isAbsolute(candidate) || !existsSync(candidate)) {
    debug(source + ' is unavailable; refusing PATH fallback')
    return undefined
  }
  try { return realpathSync(candidate) } catch {
    debug(source + ' cannot be resolved; refusing PATH fallback')
    return undefined
  }
}

// 工作区把要用的 CLI 绝对路径写在 .scry/cli-path（`scry init`/`repair` 写入，provider hook 也读它）。
// 固定猜 ~/.local/bin/scry 会在多份安装并存时静默用错版本，所以固定路径必须先于猜测。
function executable(workspace) {
  const configured = process.env.SCRY_CLI_PATH
  if (configured !== undefined) return resolveExecutable(configured, 'configured SCRY_CLI_PATH')
  let pinned
  try {
    pinned = String(readFileSync(join(workspace, '.scry', 'cli-path'), 'utf8')).split('\n')[0].trim()
  } catch {}
  if (pinned) return resolveExecutable(pinned, 'workspace .scry/cli-path')
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
  const scry = executable(workspace)
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
  const settleActive = async (status) => {
    const turn = active
    if (!turn || turn.settled) return
    turn.settled = true
    disarmSigint(flushOnSigint)
    const assistant = boundedText(turn.assistant.join('\n'))
    await enqueue(turn.workspace, 'Stop', {
      session_id: turn.sessionId,
      promptId: turn.providerTurnId,
      assistant_response: assistant.value,
      ...limitation({ assistant_response: assistant, error: turn.error }),
      ...(turn.usageObserved ? { usage: turn.usage } : {}),
      ...(turn.usageIncomplete ? { usage_complete: false } : turn.usageObserved ? { usage_complete: true } : {}),
      model_segments: turn.modelSegments,
      ...(turn.modelSegments.some((segment) => typeof segment.model === 'string')
        ? { model_ids: [...new Set(turn.modelSegments.flatMap((segment) => typeof segment.model === 'string' ? [segment.model] : []))], model_ids_complete: turn.modelSegments.every((segment) => typeof segment.model === 'string' && segment.model.length > 0) }
        : {}),
      ...(turn.error ? { error: turn.error.value } : {}),
      status,
      timestamp: new Date().toISOString(),
    })
    if (active === turn) active = undefined
  }
  const flushOnSigint = async () => {
    await settleActive('interrupted')
    await queue
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
      usageIncomplete: false,
      modelSegments: [],
      startedAt: new Date().toISOString(),
      settled: false,
    }
    armSigint(flushOnSigint)
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
    // A settled run can still have failed. A successful retry replaces the prior
    // failure, so only the last assistant response determines the terminal status.
    active.terminalStatus = message.stopReason === 'error' ? 'failed'
      : message.stopReason === 'aborted' ? 'cancelled' : undefined
    active.error = message.stopReason === 'error' && message.errorMessage
      ? boundedText(message.errorMessage, MAX_JSON_BYTES) : undefined
    const text = assistantText(message)
    if (text) active.assistant.push(text)
    active.usageObserved = addUsage(active.usage, message) || active.usageObserved
    active.usageIncomplete ||= message.stopReason === 'error' || message.stopReason === 'aborted'
    const id = message.responseId || message.id || randomUUID()
    const completedAtMs = Date.now()
    const startedAtMs = responseStartedAt ?? completedAtMs
    active.modelSegments.push({
      response_id: id,
      ...(typeof message.model === 'string' && message.model ? { model: message.model } : {}),
      completed_at: new Date(completedAtMs).toISOString(),
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
    })
    responseStartedAt = undefined
  })

  pi.on('tool_execution_start', async (event) => {
    if (!active) return
    const input = boundedJson(event.args)
    await enqueue(active.workspace, `PreToolUse:${event.toolName}`, {
      session_id: active.sessionId,
      promptId: active.providerTurnId,
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: input.value,
      ...limitation({ tool_input: input }),
      timestamp: new Date().toISOString(),
    })
  })

  pi.on('tool_execution_end', async (event) => {
    if (!active) return
    const output = boundedJson(event.result)
    await enqueue(active.workspace, event.isError ? `PostToolUseFailure:${event.toolName}` : `PostToolUse:${event.toolName}`, {
      session_id: active.sessionId,
      promptId: active.providerTurnId,
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_response: output.value,
      ...limitation({ tool_response: output }),
      ...(event.isError ? { error: true } : {}),
      timestamp: new Date().toISOString(),
    })
  })

  pi.on('agent_settled', async (event) => {
    const turn = active
    if (!turn || turn.settled) return
    await settleActive(event.aborted ? 'cancelled' : turn.terminalStatus ?? 'completed')
  })

  pi.on('session_shutdown', async () => {
    const turn = active
    await settleActive(turn?.terminalStatus ?? 'interrupted')
    disarmSigint(flushOnSigint)
    await queue
  })
}
