// A0 probe suites: protocol, auth, modes, and workspace path/hook/MCP/settings loading matrix.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLIENT_CAPS, CLIENT_INFO, makeFakeBrowser, makeIsolatedGeminiDir, startAcp
} from './acp-harness.mjs'

export async function runProto({ agyBin, temps }) {
  const root = temps.make('scry-a0-proto')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const gdir = makeIsolatedGeminiDir(root)
  const results = {}
  for (const pv of [1, 2]) {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, browserBin: browser.binPath })
    try {
      const init = await acp.request('initialize', { protocolVersion: pv, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS }, 20_000)
      results[`protocolVersion_${pv}`] = { elapsedMs: init.elapsedMs, response: init.msg, nonJsonStdout: acp.nonJsonStdout, stderrTail: acp.stderrTail() }
    } finally {
      results[`protocolVersion_${pv}`].exit = await acp.close(3_000)
    }
  }
  return { suite: 'proto', agyBin, agyVersion: execFileSync(agyBin, ['--version'], { encoding: 'utf8' }).trim(), browserCalls: browser.readCalls(), results }
}

export async function runAuth({ agyBin, temps }) {
  const root = temps.make('scry-a0-auth')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const browser = makeFakeBrowser(root)
  const out = {}

  const gdirWith = makeIsolatedGeminiDir(root)
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdirWith, browserBin: browser.binPath })
    try {
      const init = await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
      out.loggedInSkipAuth = {
        init: init.msg, sessionNewElapsedMs: sess.elapsedMs, sessionNew: sess.msg,
        nonJsonStdout: acp.nonJsonStdout, browserCallsAfter: browser.readCalls(), stderrTail: acp.stderrTail()
      }
    } finally {
      out.loggedInSkipAuth.exit = await acp.close(4_000)
    }
  }

  // Unlogged in: force file storage + empty geminiDir so Keychain is untouched and ignored.
  const gdirEmpty = makeIsolatedGeminiDir(join(root, 'empty'), { withToken: false })
  const unauthEnv = { AGY_ACP_FORCE_FILE_STORAGE: '1' }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdirEmpty, env: unauthEnv, browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] }, 12_000).catch((e) => ({ error: e.message }))
      out.unloggedInSkipAuth = { sessionNew: sess, nonJsonStdout: acp.nonJsonStdout, browserCallsAfter: browser.readCalls() }
    } finally {
      out.unloggedInSkipAuth.exit = await acp.close(3_000)
    }
  }
  {
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdirEmpty, env: { ...unauthEnv, GEMINI_API_KEY: 'dummy-probe-key' }, browserBin: browser.binPath })
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] }, 12_000).catch((e) => ({ error: e.message }))
      out.geminiApiKeyWithoutAuth = { sessionNew: sess }
    } finally {
      out.geminiApiKeyWithoutAuth.exit = await acp.close(3_000)
    }
  }
  return { suite: 'auth', browserCallsTotal: browser.readCalls(), out }
}

export async function runModes({ agyBin, temps }) {
  const root = temps.make('scry-a0-modes')
  const browser = makeFakeBrowser(root)
  const out = {}

  for (const modeId of ['default', 'accept-edits', 'auto', 'plan']) {
    const ws = join(root, `ws-${modeId}`)
    mkdirSync(ws, { recursive: true })
    const gdir = makeIsolatedGeminiDir(join(root, `g-${modeId}`), { settings: {} })
    const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, browserBin: browser.binPath })
    const perms = []
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
      const sid = sess.msg.result.sessionId
      const setRes = await acp.request('session/set_mode', { sessionId: sid, modeId })
      acp.setPermissionHandler((req, respond) => {
        perms.push({ tool: req.params?.toolCall?.name ?? req.params?.toolCall?.title, kind: req.params?.toolCall?.kind, options: req.params?.options, _meta: req.params?._meta })
        const opt = (req.params?.options ?? []).find((o) => o.kind === 'allow_always')
          ?? (req.params?.options ?? []).find((o) => o.kind === 'allow_once')
        respond(req.id, { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } })
      })
      const promptRes = await acp.request('session/prompt', {
        sessionId: sid,
        prompt: [{ type: 'text', text: 'Create a file named a.txt containing "hi", then run `echo MODE_CMD_OK`.' }]
      }, 60_000)
      out[modeId] = {
        setModeOk: !setRes.msg.error,
        perms,
        fileCreated: existsSync(join(ws, 'a.txt')),
        stopReason: promptRes.msg.result?.stopReason,
        usage: promptRes.msg.result?.usage,
        settingsAfter: JSON.parse(readFileSync(join(gdir, 'antigravity-cli', 'settings.json'), 'utf8'))
      }
    } finally {
      out[modeId].exit = await acp.close(4_000)
    }
  }

  // Test --dangerously-skip-permissions native full_access
  const wsSkip = join(root, 'ws-skip')
  mkdirSync(wsSkip, { recursive: true })
  const gdirSkip = makeIsolatedGeminiDir(join(root, 'g-skip'), { settings: {} })
  {
    const acp = startAcp({ agyBin, cwd: wsSkip, geminiDir: gdirSkip, extraArgs: ['--dangerously-skip-permissions'], browserBin: browser.binPath })
    let permCount = 0
    try {
      await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess = await acp.request('session/new', { cwd: wsSkip, mcpServers: [] })
      acp.setPermissionHandler((req, respond) => { permCount += 1; respond(req.id, { outcome: { outcome: 'cancelled' } }) })
      const promptRes = await acp.request('session/prompt', {
        sessionId: sess.msg.result.sessionId,
        prompt: [{ type: 'text', text: 'Run `echo AGY_SKIP_OK` and reply with only the output.' }]
      }, 60_000)
      out.dangerouslySkipPermissions = { permCount, stopReason: promptRes.msg.result?.stopReason, usage: promptRes.msg.result?.usage }
    } finally {
      out.dangerouslySkipPermissions.exit = await acp.close(4_000)
    }
  }
  return { suite: 'modes', browserCalls: browser.readCalls(), out }
}

export async function runPaths({ agyBin, temps }) {
  const root = temps.make('scry-a0-paths')
  const markers = join(root, 'markers')
  const parent = join(root, 'repo')
  const ws = join(parent, 'sub')
  const extPlugin = join(root, 'ext-plugins', 'ext1')
  mkdirSync(markers, { recursive: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(extPlugin, { recursive: true })
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: parent })
  const browser = makeFakeBrowser(root)

  // Real agy 1.5.12 hooks.json schema (top-level key = hook name)
  const realHook = (name) => ({
    [`probe-${name}`]: {
      SessionStart: [{ type: 'command', command: `touch "${join(markers, `hook-start-${name}`)}"`, timeout: 5 }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `touch "${join(markers, `hook-pre-${name}`)}"`, timeout: 5 }] }]
    }
  })
  const mcpBin = join(root, 'mcp-m.mjs')
  writeFileSync(mcpBin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], '1')\nsetTimeout(()=>process.exit(0),1500)\n`, { mode: 0o700 })
  const mcpCfg = (name) => ({ mcpServers: { [`m_${name}`]: { command: process.execPath, args: [mcpBin, join(markers, `mcp-${name}`)] } } })

  for (const [base, tag] of [
    [join(ws, '.agents'), 'ws-dot-agents'],
    [join(ws, '.agent'), 'ws-dot-agent'],
    [join(ws, '_agents'), 'ws-under-agents'],
    [join(ws, '_agent'), 'ws-under-agent'],
    [join(parent, '.agents'), 'parent-dot-agents'],
    [join(parent, '_agents'), 'parent-under-agents']
  ]) {
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'hooks.json'), JSON.stringify(realHook(tag), null, 2))
    writeFileSync(join(base, 'mcp_config.json'), JSON.stringify(mcpCfg(tag), null, 2))
  }

  const wsPlug = join(ws, '.agents', 'plugins', 'p1')
  mkdirSync(wsPlug, { recursive: true })
  writeFileSync(join(wsPlug, 'plugin.json'), JSON.stringify({ name: 'p1' }))
  writeFileSync(join(wsPlug, 'hooks.json'), JSON.stringify(realHook('ws-plugin-p1'), null, 2))
  writeFileSync(join(wsPlug, 'mcp_config.json'), JSON.stringify(mcpCfg('ws-plugin-p1'), null, 2))

  writeFileSync(join(extPlugin, 'plugin.json'), JSON.stringify({ name: 'ext1' }))
  writeFileSync(join(extPlugin, 'hooks.json'), JSON.stringify(realHook('plugins-json-ext1'), null, 2))
  writeFileSync(join(extPlugin, 'mcp_config.json'), JSON.stringify(mcpCfg('plugins-json-ext1'), null, 2))
  writeFileSync(join(ws, '.agents', 'plugins.json'), JSON.stringify({ entries: [{ path: join(root, 'ext-plugins') }] }, null, 2))

  const allowSettings = { toolPermission: 'always-proceed', permissions: { allow: ['command(echo HOOK_PROBE_OK)'] } }
  mkdirSync(join(ws, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(join(ws, '.gemini', 'settings.json'), JSON.stringify(allowSettings, null, 2))
  writeFileSync(join(ws, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(allowSettings, null, 2))
  writeFileSync(join(ws, '.agents', 'settings.json'), JSON.stringify(allowSettings, null, 2))

  const gdir = makeIsolatedGeminiDir(root, { settings: {} })
  writeFileSync(join(gdir, 'config', 'hooks.json'), JSON.stringify(realHook('user-config'), null, 2))

  const acp = startAcp({ agyBin, cwd: ws, geminiDir: gdir, browserBin: browser.binPath })
  let permCount = 0
  try {
    await acp.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
    const sess = await acp.request('session/new', { cwd: ws, mcpServers: [] })
    acp.setPermissionHandler((req, respond) => {
      permCount += 1
      const allow = (req.params?.options ?? []).find((o) => o.kind === 'allow_once')
      respond(req.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } })
    })
    await acp.request('session/prompt', {
      sessionId: sess.msg.result.sessionId,
      prompt: [{ type: 'text', text: 'Run `echo HOOK_PROBE_OK` and reply ONLY with the output.' }]
    }, 60_000)
  } finally {
    await acp.close(4_000)
  }

  // Verify whether user-level antigravity-cli/settings.json permissions.allow / toolPermission applies in ACP.
  const ws2 = join(root, 'ws2')
  mkdirSync(ws2, { recursive: true })
  const gdirUserAllow = makeIsolatedGeminiDir(join(root, 'u2'), {
    settings: { toolPermission: 'always-proceed', permissions: { allow: ['command(echo USER_SETTINGS_OK)'] } }
  })
  let userSettingsPermCount = 0
  {
    const acp2 = startAcp({ agyBin, cwd: ws2, geminiDir: gdirUserAllow, browserBin: browser.binPath })
    try {
      await acp2.request('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS })
      const sess2 = await acp2.request('session/new', { cwd: ws2, mcpServers: [] })
      acp2.setPermissionHandler((req, respond) => {
        userSettingsPermCount += 1
        const allow = (req.params?.options ?? []).find((o) => o.kind === 'allow_once')
        respond(req.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } })
      })
      await acp2.request('session/prompt', {
        sessionId: sess2.msg.result.sessionId,
        prompt: [{ type: 'text', text: 'Run `echo USER_SETTINGS_OK` and reply ONLY with the output.' }]
      }, 60_000)
    } finally {
      await acp2.close(4_000)
    }
  }

  return { suite: 'paths', firedMarkers: readdirSync(markers).sort(), wsSettingsPermCount: permCount, userSettingsPermCount }
}
