#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const scriptDir = dirname(process.argv[1])
const scenarioPath = join(scriptDir, 'scenario.json')
const recordPath = join(scriptDir, 'recorded.json')
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {}

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write(`${scenario.version ?? '1.5.12'}\n`)
  process.exit(0)
}
if (args.includes('--help')) {
  process.stdout.write('Usage: agy acp [--dangerously-skip-permissions]\n')
  process.exit(0)
}

const recorded = {
  argv: args,
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  browser: process.env.BROWSER ?? null,
  hasSshClient: Object.prototype.hasOwnProperty.call(process.env, 'SSH_CLIENT'),
  hasSshConnection: Object.prototype.hasOwnProperty.call(process.env, 'SSH_CONNECTION'),
  hasSshTty: Object.prototype.hasOwnProperty.call(process.env, 'SSH_TTY'),
  hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
  hasNoProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
  requests: [],
  permissionReplies: [],
  clientErrorReplies: [],
  spawnedChildPids: []
}

if (scenario.recordSpawns) {
  try { appendFileSync(join(scriptDir, 'spawns.log'), `${process.pid}\n`) } catch { /* ignore */ }
}

function saveRecord() {
  try { writeFileSync(recordPath, JSON.stringify(recorded, null, 2)) } catch { /* ignore */ }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

let currentModel = scenario.defaultModel ?? 'gemini-3-pro'
let currentThought = scenario.defaultThought ?? 'medium'
let currentMode = args.includes('--dangerously-skip-permissions') ? 'bypass' : 'default'
let authenticated = scenario.authMode !== 'unauthenticated_32000' &&
  scenario.authMode !== 'no_browser_32603' &&
  scenario.authMode !== 'login_prompt_line' &&
  scenario.authMode !== 'require_api_key_auth' &&
  scenario.authMode !== 'require_adc_auth'
let activePrompt = null
let incomingReqCounter = 0
const pendingClientRequests = new Map()
const spawnedChildren = []

const modelList = scenario.models ?? [
  { value: 'gemini-3-pro', name: 'Gemini 3 Pro', thoughts: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', thoughts: ['low', 'medium', 'high'] }
]

function configOptionsFor(modelId) {
  const found = modelList.find((m) => m.value === modelId) ?? modelList[0]
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: found.value,
      options: modelList.map((m) => ({ value: m.value, name: m.name }))
    },
    {
      id: 'thought_level',
      name: 'Thought Level',
      category: 'thought_level',
      type: 'select',
      currentValue: found.thoughts.includes(currentThought) ? currentThought : found.thoughts[0],
      options: found.thoughts.map((t) => ({ value: t, name: t }))
    }
  ]
}

function sendClientRequest(method, params) {
  const id = String(++incomingReqCounter)
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function handlePrompt(msg) {
  const sessionId = msg.params?.sessionId ?? 'sess-fake-1'
  let cancelled = false
  activePrompt = {
    id: msg.id,
    cancel: () => {
      cancelled = true
    }
  }
  const steps = scenario.promptSteps ?? [
    { type: 'thought', text: 'thinking step' },
    { type: 'text', text: 'hello from fake agy' }
  ]

  for (const step of steps) {
    if (cancelled && !scenario.ignoreCancel) break
    if (step.type === 'non_json') {
      process.stdout.write(`${step.line}\n`)
    } else if (step.type === 'oversize_line') {
      const len = step.bytes ?? (16 * 1024 * 1024 + 64)
      process.stdout.write(`${'x'.repeat(len)}\n`)
    } else if (step.type === 'thought') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.text } } }
      })
    } else if (step.type === 'text') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } } }
      })
    } else if (step.type === 'tool_call') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'tool_call', ...step.data } }
      })
    } else if (step.type === 'tool_call_update') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'tool_call_update', ...step.data } }
      })
    } else if (step.type === 'usage_update') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'usage_update', used: step.used, size: step.size } }
      })
    } else if (step.type === 'unknown_update') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: step.name ?? 'future_update_v9', payload: step.payload ?? { ok: true } } }
      })
    } else if (step.type === 'unknown_agent_request') {
      const reply = await sendClientRequest(step.method ?? 'agent/unknown_method', { x: 1 })
      recorded.clientErrorReplies.push(reply)
      saveRecord()
    } else if (step.type === 'request_permission') {
      const reply = await sendClientRequest('session/request_permission', {
        sessionId,
        toolCall: step.toolCall,
        options: step.options,
        ...(step._meta ? { _meta: step._meta } : {})
      })
      recorded.permissionReplies.push(reply)
      saveRecord()
    } else if (step.type === 'spawn_detached_child') {
      const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${step.ms ?? 30000})`], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      spawnedChildren.push(child)
      if (child.pid) recorded.spawnedChildPids.push(child.pid)
      saveRecord()
    } else if (step.type === 'sleep') {
      const end = Date.now() + (step.ms ?? 50)
      while (Date.now() < end) {
        if (cancelled && !scenario.ignoreCancel) break
        await new Promise((r) => setTimeout(r, 15))
      }
    } else if (step.type === 'call_mcp') {
      const srv = recorded.requests.find((r) => r.method === 'session/new')?.params?.mcpServers?.[0]
      if (srv?.url) {
        const headers = Object.fromEntries((srv.headers ?? []).map((h) => [h.name, h.value]))
        try {
          const res = await fetch(srv.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
          })
          recorded.mcpCallStatus = res.status
        } catch (err) {
          recorded.mcpCallError = String(err?.message ?? err)
        }
        saveRecord()
      }
    } else if (step.type === 'crash') {
      if (step.stderr) process.stderr.write(`${step.stderr}\n`)
      saveRecord()
      process.exit(step.exitCode ?? 1)
    }
  }

  activePrompt = null
  if (scenario.ignoreCancel && cancelled) {
    // Stay hung until killed by RunStopLifecycle forceKill.
    await new Promise(() => {})
    return
  }
  if (scenario.promptError) {
    send({ jsonrpc: '2.0', id: msg.id, error: scenario.promptError })
    saveRecord()
    return
  }
  const stopReason = cancelled && !scenario.endTurnAfterCancel
    ? 'cancelled'
    : (scenario.stopReason ?? 'end_turn')
  const result = { stopReason }
  if (scenario.usage !== null) {
    result.usage = scenario.usage ?? {
      inputTokens: 100,
      cachedReadTokens: 40,
      cachedWriteTokens: 10,
      outputTokens: 50,
      thoughtTokens: 20,
      totalTokens: 200
    }
  }
  send({ jsonrpc: '2.0', id: msg.id, result })
  if (Array.isArray(scenario.trailingUpdatesAfterResult)) {
    for (const trailing of scenario.trailingUpdatesAfterResult) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: trailing } })
    }
  }
  saveRecord()
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.id !== undefined && !msg.method) {
    const key = String(msg.id)
    const resolver = pendingClientRequests.get(key)
    if (resolver) {
      pendingClientRequests.delete(key)
      resolver(msg)
    }
    return
  }

  recorded.requests.push({ method: msg.method, params: msg.params })
  saveRecord()

  if (msg.method === 'initialize') {
    if (scenario.hangOnInitialize) return
    if (scenario.nonJsonBeforeInit) process.stdout.write(`${scenario.nonJsonBeforeInit}\n`)
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: scenario.protocolVersion ?? 1,
        agentInfo: { name: 'Antigravity ACP Server', version: scenario.version ?? '1.5.12' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} }
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Personal Google Account' },
          { id: 'gemini-api-key', name: 'Gemini API Key' },
          { id: 'agent-platform', name: 'Agent Platform' }
        ]
      }
    })
    return
  }

  if (msg.method === 'authenticate') {
    const methodId = msg.params?.methodId
    if (methodId === 'gemini-api-key' && process.env.GEMINI_API_KEY) {
      authenticated = true
      send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    } else if (methodId === 'agent-platform' && process.env.GOOGLE_CLOUD_PROJECT) {
      authenticated = true
      send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'No browser is available here' } })
    }
    return
  }

  if (msg.method === 'session/new' || msg.method === 'session/resume' || msg.method === 'session/load') {
    if (scenario.sessionNewDelayMs && msg.method === 'session/new') {
      await new Promise((r) => setTimeout(r, scenario.sessionNewDelayMs))
    }
    if (scenario.authMode === 'login_prompt_line') {
      process.stdout.write('Please visit https://accounts.google.com/o/oauth2/auth?state=SECRET_OAUTH_STATE_12345 to sign in\n')
    }
    if (!authenticated) {
      if (scenario.authMode === 'no_browser_32603') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'No browser is available here' } })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } })
      }
      return
    }
    if (msg.method === 'session/resume' && scenario.failResume) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'resume unsupported' } })
      return
    }
    const sessionId = msg.params?.sessionId ?? scenario.sessionId ?? 'sess-fake-1'
    if (msg.method === 'session/load' && Array.isArray(scenario.loadReplay)) {
      for (const replay of scenario.loadReplay) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: replay } })
      }
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        configOptions: configOptionsFor(currentModel),
        modes: {
          currentModeId: currentMode,
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'accept-edits', name: 'Accept Edits' },
            { id: 'auto', name: 'Auto' },
            { id: 'plan', name: 'Plan' }
          ]
        }
      }
    })
    if (Array.isArray(scenario.availableCommands)) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: scenario.availableCommands }
        }
      })
    }
    return
  }

  if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId === 'model') currentModel = msg.params.value
    if (msg.params?.configId === 'thought_level') currentThought = msg.params.value
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptionsFor(currentModel) } })
    return
  }

  if (msg.method === 'session/set_mode') {
    currentMode = msg.params?.modeId ?? currentMode
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  if (msg.method === 'session/cancel') {
    activePrompt?.cancel()
    return
  }

  if (msg.method === 'session/prompt') {
    void handlePrompt(msg)
    return
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } })
})

rl.on('close', () => {
  saveRecord()
  if (scenario.hangOnStdinClose) return
  process.exit(0)
})
