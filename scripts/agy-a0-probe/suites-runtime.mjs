// A0 probe suites: MCP injection + disk token scan, lifecycle/resume/load, cancel/pgid/SIGTERM,
// usage/configOptions, subagent, macOS launchd env, and Chinese/space paths.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CLIENT_CAPS, CLIENT_INFO, makeFakeBrowser, makeIsolatedGeminiDir, startAcp
} from './acp-harness.mjs'

export async function runMcp({ agyBin, temps }) {
  const root = temps.make('scry-a0-mcp')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const token = `scry-probe-secret-${Date.now().toString(16)}`
  const receivedRequests = []

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ignore */ }
      receivedRequests.push({ method: req.method, url: req.url, hasExactAuthHeader: req.headers.authorization === `Bearer ${token}`, rpcMethod: body?.method ?? null })
      if (req.method !== 'POST' || !body) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'scry-probe-mcp', version: '1.0.0' } }
      else if (body.method === 'tools/list') result = { tools: [{ name: 'scry_probe_echo', description: 'Echo probe', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] }
      else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: `ECHO_OK:${body.params?.arguments?.msg ?? ''}` }] }
      else if (body.id === undefined) { res.writeHead(202).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
  let argvSnapshot = ''
  let promptRes
  try {
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', {
      cwd: ws,
      mcpServers: [{ type: 'http', name: 'scry_probe', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }]
    })
    argvSnapshot = execFileSync('/bin/ps', ['-p', String(acp.child.pid), '-o', 'args='], { encoding: 'utf8' }).trim()
    promptRes = await acp.request('session/prompt', {
      sessionId: sess.msg.result.sessionId,
      prompt: [{ type: 'text', text: 'Call scry_probe_echo with msg="hello" and reply with its exact output.' }]
    }, 60_000)
  } finally {
    await acp.close(4_000)
    server.close()
  }

  const tokenHits = []
  const scan = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) scan(p)
      else if (ent.isFile()) {
        try { if (readFileSync(p).includes(Buffer.from(token))) tokenHits.push(p.replace(gdir, '<tempGemini>')) } catch { /* ignore */ }
      }
    }
  }
  scan(gdir)
  return { suite: 'mcp', argvContainsToken: argvSnapshot.includes(token), receivedRequests, tokenPersistedInFiles: tokenHits, promptResponse: promptRes?.msg }
}

export async function runLifecycle({ agyBin, temps }) {
  const root = temps.make('scry-a0-life')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const out = {}
  let sessionId

  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
    sessionId = sess.msg.result.sessionId
    const promptRes = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Remember the code word PINEAPPLE42. Reply ONLY with OK.' }] }, 60_000)
    const countAtResp = acp.notifications.length
    await new Promise((r) => setTimeout(r, 600))
    out.firstRun = {
      sessionId, promptElapsedMs: promptRes.elapsedMs, promptResponse: promptRes.msg,
      trailingUpdatesIn600ms: acp.notifications.slice(countAtResp).map((n) => n.msg?.params?.update?.sessionUpdate ?? n.msg?.method),
      closeStdinExit: await acp.close(6_000)
    }
  }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const resumed = await acp.request('session/resume', { sessionId, cwd: ws, mcpServers: [] }, 20_000)
      const replayed = acp.notifications.length
      const recall = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'What code word did I ask you to remember? Reply with ONLY the code word.' }] }, 60_000)
      out.resume = {
        elapsedMs: resumed.elapsedMs, replayedNotificationsCount: replayed, recallResponse: recall.msg,
        recallText: acp.notifications.filter((n) => n.msg?.params?.update?.sessionUpdate === 'agent_message_chunk').map((n) => n.msg.params.update.content?.text ?? '').join('')
      }
    } finally { out.resume.exit = await acp.close(4_000) }
  }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const loaded = await acp.request('session/load', { sessionId, cwd: ws, mcpServers: [] }, 20_000)
      out.load = {
        elapsedMs: loaded.elapsedMs, replayedNotificationsCount: acp.notifications.length,
        replayedTypes: [...new Set(acp.notifications.map((n) => n.msg?.params?.update?.sessionUpdate ?? n.msg?.method))]
      }
    } finally { out.load.exit = await acp.close(4_000) }
  }
  return { suite: 'lifecycle', out }
}

export async function runCancel({ agyBin, temps }) {
  const root = temps.make('scry-a0-cancel')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const out = {}

  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
      const sid = sess.msg.result.sessionId
      let gotPerm = null
      let permRespond = null
      acp.setPermissionHandler((req, respond) => { gotPerm = req; permRespond = respond })
      const promptP = acp.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Run shell command `sleep 15`.' }] }, 30_000).catch((e) => ({ error: e.message }))
      const deadline = Date.now() + 25_000
      while (!gotPerm && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      const cancelAt = Date.now()
      acp.notify('session/cancel', { sessionId: sid })
      let resolvedBeforeReply = false
      const raced = await Promise.race([promptP.then((r) => { resolvedBeforeReply = true; return r }), new Promise((r) => setTimeout(() => r(null), 1500))])
      let finalPrompt = raced
      if (!resolvedBeforeReply && gotPerm && permRespond) { permRespond(gotPerm.id, { outcome: { outcome: 'cancelled' } }); finalPrompt = await promptP }
      out.cancelDuringPendingPermission = { gotPermissionRequest: Boolean(gotPerm), resolvedBeforePermissionReply: resolvedBeforeReply, cancelToSettleMs: Date.now() - cancelAt, promptResponse: finalPrompt?.msg ?? finalPrompt }
    } finally { out.cancelDuringPendingPermission.exit = await acp.close(4_000) }
  }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
      const sid = sess.msg.result.sessionId
      const promptP = acp.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Run the shell command: echo AGY_SLEEP && sleep 20' }] }, 30_000).catch((e) => ({ error: e.message }))
      let sleepProc = null
      const deadline = Date.now() + 25_000
      while (!sleepProc && Date.now() < deadline) {
        const line = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).split('\n').find((l) => l.includes('sleep 20') && !l.includes('echo '))
        if (line) sleepProc = line.trim()
        else await new Promise((r) => setTimeout(r, 150))
      }
      const agyPs = execFileSync('/bin/ps', ['-p', String(acp.child.pid), '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).trim()
      const cancelAt = Date.now()
      acp.notify('session/cancel', { sessionId: sid })
      const promptRes = await promptP
      await new Promise((r) => setTimeout(r, 400))
      const sleepAfter = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('sleep 20'))
      out.cancelDuringShellCommand = { agyPs, sleepProcBeforeCancel: sleepProc, cancelToSettleMs: Date.now() - cancelAt, promptResponse: promptRes?.msg ?? promptRes, sleepLeftoversAfterCancel: sleepAfter }
    } finally { out.cancelDuringShellCommand.exit = await acp.close(4_000) }
  }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, browserBin: browser.binPath })
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    await acp.request('session/new', { cwd: ws, mcpServers: [] })
    const t0 = Date.now()
    process.kill(acp.child.pid, 'SIGTERM')
    const exit = await acp.waitExit(8_000)
    out.sigtermIdle = { ...exit, totalMs: Date.now() - t0 }
    if (exit.timedOut) { try { process.kill(-acp.child.pid, 'SIGKILL') } catch { /* ignore */ } }
  }
  return { suite: 'cancel', out }
}

export async function runUsage({ agyBin, temps }) {
  const root = temps.make('scry-a0-usage')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const before = readFileSync(join(gdir, 'antigravity-cli', 'settings.json'), 'utf8')
  const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
  const out = {}
  try {
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
    const sid = sess.msg.result.sessionId
    out.initialConfigOptions = sess.msg.result.configOptions
    const modelOpt = (sess.msg.result.configOptions ?? []).find((c) => c.id === 'model')
    const alt = modelOpt?.options?.find((o) => o.value !== modelOpt.currentValue)?.value
    if (modelOpt && alt) {
      out.setModelResult = { switchedTo: alt, response: (await acp.request('session/set_config_option', { sessionId: sid, configId: modelOpt.id, value: alt }, 15_000)).msg }
    }
    out.promptResponse = (await acp.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Reply with the single word: PONG' }] }, 60_000)).msg
    out.usageNotifications = acp.notifications.filter((n) => n.msg?.params?.update?.sessionUpdate === 'usage_update')
  } finally { out.exit = await acp.close(4_000) }
  out.settingsChangedByModelSwitch = before !== readFileSync(join(gdir, 'antigravity-cli', 'settings.json'), 'utf8')
  return { suite: 'usage', out }
}

export async function runSubagent({ agyBin, temps }) {
  const root = temps.make('scry-a0-sub')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'fact.txt'), 'SUBAGENT_MARKER_777\n')
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
  try {
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
    const promptRes = await acp.request('session/prompt', {
      sessionId: sess.msg.result.sessionId,
      prompt: [{ type: 'text', text: 'Use a research subagent (invoke_subagent) to read fact.txt in this workspace and return its exact text.' }]
    }, 90_000)
    const toolCalls = acp.notifications
      .filter((n) => n.msg?.params?.update?.sessionUpdate === 'tool_call' || n.msg?.params?.update?.sessionUpdate === 'tool_call_update')
      .map((n) => ({
        sessionUpdate: n.msg.params.update.sessionUpdate, toolCallId: n.msg.params.update.toolCallId,
        name: n.msg.params.update.name, title: n.msg.params.update.title, kind: n.msg.params.update.kind, status: n.msg.params.update.status
      }))
    return { suite: 'subagent', updateTypes: [...new Set(acp.notifications.map((n) => n.msg?.params?.update?.sessionUpdate))], toolCalls, promptResponse: promptRes.msg }
  } finally { await acp.close(4_000) }
}

export async function runLaunchd({ agyBin, temps }) {
  const root = temps.make('scry-a0-launchd')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const uid = process.getuid()
  const label = `com.scry.a0.probe.${process.pid}`
  const target = `gui/${uid}/${label}`
  const outJson = join(root, 'launchd-result.json')
  const runnerScript = join(root, 'run-under-launchd.mjs')
  const plistPath = join(root, `${label}.plist`)
  const browser = makeFakeBrowser(root)

  writeFileSync(runnerScript, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'
const child = spawn(${JSON.stringify(agyBin)}, ['acp'], { cwd: ${JSON.stringify(ws)}, stdio: ['pipe', 'pipe', 'pipe'] })
const rl = readline.createInterface({ input: child.stdout })
let stderr = ''
child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
const replies = new Map()
rl.on('line', (l) => { try { const m = JSON.parse(l); if (m.id) replies.set(m.id, m) } catch {} })
const send = (m) => child.stdin.write(JSON.stringify(m) + '\\n')
const wait = async (id, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (replies.has(id)) return replies.get(id); await new Promise((r) => setTimeout(r, 50)) } return { timeout: true } }
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'scry', version: '0.2.250' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })
const init = await wait(1)
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: ${JSON.stringify(ws)}, mcpServers: [] } })
const sess = await wait(2)
child.stdin.end()
setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 2000)
writeFileSync(${JSON.stringify(outJson)}, JSON.stringify({
  envKeys: Object.keys(process.env).sort(), initOk: Boolean(init?.result), sessionNewOk: Boolean(sess?.result?.sessionId),
  sessionNewError: sess?.error ?? null, modelCount: (sess?.result?.configOptions ?? []).find((c) => c.id === 'model')?.options?.length ?? 0, stderrTail: stderr.slice(-500)
}, null, 2))
process.exit(0)
`)
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${runnerScript}</string></array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${homedir()}</string>
    <key>PATH</key><string>/Users/bingjiang/.local/bin:/usr/bin:/bin</string>
    <key>BROWSER</key><string>${browser.binPath}</string>
  </dict>
</dict></plist>
`, { mode: 0o600 })
  try {
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath], { timeout: 10_000 })
    const end = Date.now() + 25_000
    while (!existsSync(outJson) && Date.now() < end) await new Promise((r) => setTimeout(r, 200))
    return { suite: 'launchd', label, data: existsSync(outJson) ? JSON.parse(readFileSync(outJson, 'utf8')) : { error: 'launchd_probe_timeout' } }
  } finally {
    try { execFileSync('/bin/launchctl', ['bootout', target], { timeout: 10_000 }) } catch { /* ignore */ }
  }
}

export async function runZh({ agyBin, temps }) {
  const root = temps.make('scry-a0-zh')
  const ws = join(root, '测试 项目')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, '说明.txt'), '中文内容测试：你好世界\n')
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, extraArgs: ['--dangerously-skip-permissions'], env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }, browserBin: browser.binPath })
  try {
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
    const sid = sess.msg.result?.sessionId
    if (!sid) return { suite: 'zh', cwd: ws, sessionNewError: sess.msg.error ?? sess.msg }
    const promptRes = await acp.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '读取当前目录下的「说明.txt」，只回复该文件的原文内容。' }] }, 60_000)
    const replyText = acp.notifications.filter((n) => n.msg?.params?.update?.sessionUpdate === 'agent_message_chunk').map((n) => n.msg.params.update.content?.text ?? '').join('')
    const toolLocations = acp.notifications.filter((n) => n.msg?.params?.update?.locations).map((n) => n.msg.params.update.locations)
    return { suite: 'zh', cwd: ws, replyText, toolLocations, promptResponse: promptRes.msg, exit: await acp.close(4_000) }
  } finally { await acp.close(3_000) }
}
