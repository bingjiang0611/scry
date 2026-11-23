#!/usr/bin/env node
// P6-0 real-host probe for Codex and Qoder (docs/plans/remote-runtime-v2/P6-multi-agent-plan.md §W1).
// Uses temporary workspaces and isolated CODEX_HOME; never touches ~/.scry or real projects.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createSdkMcpServer, qodercliAuth, query, tool } from '@qoder-ai/qoder-agent-sdk'
import { z } from 'zod'

const evidenceDir = process.env.SCRY_P6_0_EVIDENCE_DIR || join(homedir(), '.local/state/scry-handoff-evidence/W20-p6-0')
mkdirSync(evidenceDir, { recursive: true })

function startProbeMcpServer() {
  const calls = []
  const server = createServer((req, res) => {
    const auth = req.headers.authorization || ''
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let msg
      try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (msg.method === 'initialize') {
        calls.push({ method: 'initialize', auth })
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'scry_orchestrator', version: '0.1.0' }
          }
        })
        return
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end()
        return
      }
      if (msg.method === 'tools/list') {
        calls.push({ method: 'tools/list', auth })
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'scry_probe_read',
                description: 'Read-only probe tool. Returns ok.',
                inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false },
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
              },
              {
                name: 'scry_probe_write',
                description: 'Write probe tool. Returns ok.',
                inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false },
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
              },
              {
                name: 'scry_probe_slow',
                description: 'Sleeps for delayMs (default 21000) and returns ok.',
                inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } }, additionalProperties: false },
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
              }
            ]
          }
        })
        return
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name
        const args = msg.params?.arguments || {}
        calls.push({ method: 'tools/call', name, args, auth, at: Date.now() })
        if (name === 'scry_probe_slow') {
          const delayMs = Math.min(Math.max(0, Number(args.delayMs ?? 21_000)), 25_000)
          await new Promise((r) => setTimeout(r, delayMs))
          reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, waitedMs: delayMs }) }] } })
          return
        }
        reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, tag: args.tag ?? null }) }] } })
        return
      }
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        calls,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

async function runCodexProbes() {
  const workDir = mkdtempSync(join(tmpdir(), 'scry-p6-0-codex-ws-'))
  const codexHome = mkdtempSync(join(tmpdir(), 'scry-p6-0-codex-home-'))
  const realAuth = join(homedir(), '.codex', 'auth.json')
  if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'))
  const mcp = await startProbeMcpServer()
  const tok1 = randomBytes(32).toString('hex')
  const tok2 = randomBytes(32).toString('hex')
  const fakeEnvSecret = `probe_secret_${randomBytes(8).toString('hex')}`

  const args = [
    '-c', `projects={${JSON.stringify(workDir)}={trust_level="trusted"}}`,
    '-c', 'default_permissions=":workspace"',
    'app-server',
    '--strict-config',
    '--disable', 'apps',
    '--disable', 'plugins',
    '--disable', 'remote_plugin',
    '--disable', 'external_migration',
    '--disable', 'skill_mcp_dependency_install'
  ]

  const child = spawn('codex', args, {
    cwd: workDir,
    env: { ...process.env, CODEX_HOME: codexHome, SCRY_PROBE_FAKE_TOKEN: fakeEnvSecret },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stderrLines = []
  const serverRequests = []
  const notifications = []
  const pending = new Map()
  let nextId = 1
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && msg.method) {
      serverRequests.push({ method: msg.method, params: msg.params })
      // Auto-approve any approval request so the probe completes and we observe the exact method/params.
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'accept' } }) + '\n')
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (msg.method) notifications.push(msg)
  })
  child.stderr.on('data', (d) => stderrLines.push(d.toString()))

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  const runTurn = async (threadId, prompt) => {
    const startIdx = notifications.length
    const t0 = Date.now()
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn_timeout')), 90_000)
      const check = setInterval(() => {
        for (let i = startIdx; i < notifications.length; i++) {
          if (notifications[i].method === 'turn/completed' && notifications[i].params?.threadId === threadId) {
            clearInterval(check)
            clearTimeout(timer)
            const slice = notifications.slice(startIdx)
            const texts = slice
              .filter((n) => n.method === 'item/agentMessage/delta')
              .map((n) => n.params?.delta || '')
              .join('')
            resolve({ durationMs: Date.now() - t0, status: notifications[i].params?.turn?.status, text: texts })
            return
          }
        }
      }, 100)
    })
  }

  const out = { version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() }
  try {
    await rpc('initialize', { clientInfo: { name: 'scry-p6-0-probe', version: '0.1.0' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')

    // Probe 6: config/read
    const cfg = await rpc('config/read', { cwd: workDir })
    out.probe6_configRead = {
      features: cfg?.config?.features ?? null,
      codeModeKeys: JSON.stringify(cfg).match(/code_mode|omit_tools_from/g) || []
    }

    // Probe 1 + 3 + 5: thread/start with thread-level MCP config & http_headers under --strict-config
    const tStart1 = Date.now()
    const th1 = await rpc('thread/start', {
      cwd: workDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          scry_orchestrator: {
            url: mcp.url,
            http_headers: { Authorization: `Bearer ${tok1}` },
            tool_timeout_sec: 30
          }
        }
      }
    })
    const thread1Id = th1.thread.id
    out.probe1_thread1StartMs = Date.now() - tStart1

    // Check ps argv for secret leakage
    const psCmd = execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' })
    out.probe1_tokenInArgv = psCmd.includes(tok1)

    const turn1 = await runTurn(
      thread1Id,
      'Call the MCP tool scry_probe_read with tag "t1-read", then call scry_probe_write with tag "t1-write". Reply with DONE.'
    )
    out.probe1_3_5_turn1 = {
      status: turn1.status,
      durationMs: turn1.durationMs,
      serverRequests: serverRequests.map((r) => ({ method: r.method, keys: Object.keys(r.params || {}) })),
      mcpCallsAfterTurn1: mcp.calls.map((c) => ({
        method: c.method,
        name: c.name,
        args: c.args,
        matchedTok1: c.auth === `Bearer ${tok1}`
      }))
    }

    // Probe 1 (reuse): second thread on SAME pooled app-server with DIFFERENT bearer token
    const tStart2 = Date.now()
    const th2 = await rpc('thread/start', {
      cwd: workDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          scry_orchestrator: {
            url: mcp.url,
            http_headers: { Authorization: `Bearer ${tok2}` },
            tool_timeout_sec: 30
          }
        }
      }
    })
    out.probe1_thread2StartMs = Date.now() - tStart2
    const beforeT2 = mcp.calls.length
    const turn2 = await runTurn(
      th2.thread.id,
      'Call the MCP tool scry_probe_read with tag "t2-read". Reply with DONE.'
    )
    out.probe1_thread2Reuse = {
      status: turn2.status,
      durationMs: turn2.durationMs,
      mcpCalls: mcp.calls.slice(beforeT2).map((c) => ({
        method: c.method,
        name: c.name,
        args: c.args,
        matchedTok2: c.auth === `Bearer ${tok2}`,
        matchedTok1: c.auth === `Bearer ${tok1}`
      }))
    }

    // Probe 4: does Codex leak *TOKEN* env var into shell commands?
    const turn4 = await runTurn(
      thread1Id,
      'Run the shell command `if [ -n "${SCRY_PROBE_FAKE_TOKEN:-}" ]; then echo PRESENT; else echo FILTERED; fi` and reply with only PRESENT or FILTERED.'
    )
    out.probe4_tokenEnv = { status: turn4.status, text: turn4.text.trim() }

    // Probe 9: 21s slow MCP tool call with tool_timeout_sec: 30
    const beforeSlow = mcp.calls.length
    const turn9 = await runTurn(
      thread1Id,
      'Call the MCP tool scry_probe_slow with delayMs 21000. Reply with the waitedMs value.'
    )
    out.probe9_slow21s = {
      status: turn9.status,
      durationMs: turn9.durationMs,
      text: turn9.text.trim(),
      called: mcp.calls.slice(beforeSlow).some((c) => c.name === 'scry_probe_slow')
    }
  } catch (err) {
    out.error = String(err?.stack || err)
    out.stderrTail = stderrLines.join('').slice(-2000)
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) { r(); return }
      const t = setTimeout(() => { child.kill('SIGKILL'); r() }, 3_000)
      child.once('exit', () => { clearTimeout(t); r() })
    })
    await mcp.close()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return out
}

async function runQoderProbes() {
  const workDir = mkdtempSync(join(tmpdir(), 'scry-p6-0-qoder-ws-'))
  const out = { version: execFileSync('qoder', ['--version'], { encoding: 'utf8' }).trim() }
  const invoked = []
  const canUseToolCalls = []
  const capturedArgv = []
  try {
    const sdkServer = createSdkMcpServer({
      name: 'scry_orchestrator',
      version: '0.1.0',
      tools: [
        tool('scry_probe_read', 'Read-only probe tool', { tag: z.string().optional() }, async (args) => {
          invoked.push({ tool: 'scry_probe_read', args })
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'scry_probe_read', tag: args.tag ?? null }) }] }
        }),
        tool('scry_probe_write', 'Write probe tool', { tag: z.string().optional() }, async (args) => {
          invoked.push({ tool: 'scry_probe_write', args })
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'scry_probe_write', tag: args.tag ?? null }) }] }
        }),
        tool('scry_probe_slow', 'Slow probe tool (21s)', { delayMs: z.number().optional() }, async (args) => {
          const delayMs = Math.min(Math.max(0, Number(args.delayMs ?? 21_000)), 25_000)
          await new Promise((r) => setTimeout(r, delayMs))
          invoked.push({ tool: 'scry_probe_slow', delayMs })
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, waitedMs: delayMs }) }] }
        })
      ]
    })

    // Probe 2 + 9: in-process SDK MCP server + 21s wait
    const q1 = query({
      prompt: 'Call scry_probe_read with tag "q-read", then call scry_probe_slow with delayMs 21000. Reply DONE.',
      options: {
        auth: qodercliAuth(),
        cwd: workDir,
        permissionMode: 'default',
        strictMcpConfig: true,
        mcpServers: { scry_orchestrator: sdkServer },
        canUseTool: async (toolName, input) => {
          canUseToolCalls.push({ run: 1, toolName, input })
          return { behavior: 'allow', updatedInput: input }
        },
        spawnQoderCLIProcess: (opts) => {
          capturedArgv.push(opts.args)
          return spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
        }
      }
    })
    let result1 = null
    for await (const msg of q1) {
      if (msg.type === 'result') result1 = { subtype: msg.subtype, is_error: msg.is_error, duration_ms: msg.duration_ms }
    }
    const mcpArgIdx = (capturedArgv[0] || []).indexOf('--mcp-config')
    const mcpConfigArg = mcpArgIdx >= 0 ? capturedArgv[0][mcpArgIdx + 1] : null
    out.probe2_9_inProcessMcp = {
      result: result1,
      invoked,
      canUseToolCalls: canUseToolCalls.filter((c) => c.run === 1).map((c) => c.toolName),
      mcpConfigArgContainsOrchestrator: mcpConfigArg ? mcpConfigArg.includes('scry_orchestrator') : false,
      mcpConfigArgPresent: mcpArgIdx >= 0
    }

    // Probe 7: Does .qoder/settings.json permissions.allow bypass canUseTool?
    mkdirSync(join(workDir, '.qoder'), { recursive: true })
    writeFileSync(
      join(workDir, '.qoder', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__scry_orchestrator__*'] } }, null, 2)
    )
    const beforeInvoked = invoked.length
    const q2 = query({
      prompt: 'Call scry_probe_write with tag "q-settings-test". Reply DONE.',
      options: {
        auth: qodercliAuth(),
        cwd: workDir,
        permissionMode: 'default',
        strictMcpConfig: true,
        settingSources: ['user', 'project', 'local'],
        mcpServers: { scry_orchestrator: sdkServer },
        canUseTool: async (toolName, input) => {
          canUseToolCalls.push({ run: 2, toolName, input })
          return { behavior: 'allow', updatedInput: input }
        }
      }
    })
    let result2 = null
    for await (const msg of q2) {
      if (msg.type === 'result') result2 = { subtype: msg.subtype, is_error: msg.is_error, duration_ms: msg.duration_ms }
    }
    out.probe7_projectSettingsBypass = {
      result: result2,
      writeToolInvoked: invoked.slice(beforeInvoked).some((c) => c.tool === 'scry_probe_write'),
      canUseToolCalledInRun2: canUseToolCalls.filter((c) => c.run === 2).map((c) => c.toolName)
    }
  } catch (err) {
    out.error = String(err?.stack || err)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
  return out
}

const results = {
  at: new Date().toISOString(),
  os: `${process.platform}-${process.arch}`,
  locale: process.env.LANG || process.env.LC_ALL || 'unknown'
}
results.codex = await runCodexProbes()
writeFileSync(join(evidenceDir, 'probe-results.json'), JSON.stringify(results, null, 2))
results.qoder = await runQoderProbes()
writeFileSync(join(evidenceDir, 'probe-results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
