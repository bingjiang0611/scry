#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repo, 'packages/turn-recorder-cli/dist/cli/scry.js')
const outDir = process.env.SCRY_W23_OUT ?? join(process.env.HOME ?? tmpdir(), '.local/state/scry-handoff-evidence/W23')
const RUNS = Number(process.env.SCRY_W23_RUNS ?? 3)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function hookScript(path, entry, workspace) {
  await writeFile(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} recorder hook --provider claude --event "$1" --workspace ${JSON.stringify(workspace)}\n`)
  await chmod(path, 0o700)
}

async function hook(script, event, payload, env) {
  const started = process.hrtime.bigint()
  const child = spawn(script, [event], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exit = new Promise((done) => child.once('exit', (code) => done(code)))
  child.stdin.end(JSON.stringify(payload))
  const code = await exit
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  return { event, code, elapsedMs: Math.round(elapsedMs), stdout: stdout.trim(), stderr: stderr.trim() }
}

async function daemonUp(workspace, env) {
  const started = process.hrtime.bigint()
  for (let attempt = 0; attempt < 400; attempt++) {
    const marker = join(workspace, '.scry', 'recorder-socket-path')
    if (existsSync(marker)) {
      const status = await run(process.execPath, [cli, 'recorder', 'status', '--workspace', workspace], { env }).catch(() => undefined)
      if (/"running"\s*:\s*true/.test(status?.stdout ?? '')) {
        return Math.round(Number(process.hrtime.bigint() - started) / 1e6)
      }
    }
    await sleep(25)
  }
  return null
}

async function makeWorkspace(name, entry, env) {
  const root = await mkdtemp(join(tmpdir(), `scry-w23-${name}-`))
  const home = join(root, 'home')
  const workspace = join(root, 'ws')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: `w23-${name}`,
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const script = join(root, 'hook.sh')
  await hookScript(script, entry, workspace)
  return { root, home, workspace, script, env: { ...env, HOME: home } }
}

async function recordSummary(workspace) {
  const recordsDir = join(workspace, '.scry', 'records')
  const names = await readdir(recordsDir).catch(() => [])
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = JSON.parse(await readFile(join(recordsDir, name), 'utf8'))
    records.push({ recordId: record.recordId, status: record.status, generation: record.generation, recorderVersion: record.recorderVersion })
  }
  const health = await readFile(join(workspace, '.scry', 'state', 'health.json'), 'utf8').catch(() => undefined)
  const logs = await readdir(join(workspace, '.scry', 'logs')).catch(() => [])
  const logText = []
  for (const name of logs) {
    if (!name.startsWith('recorder.log')) continue
    logText.push(await readFile(join(workspace, '.scry', 'logs', name), 'utf8').catch(() => ''))
  }
  return {
    records,
    health: health ? JSON.parse(health) : null,
    captureUncertain: existsSync(join(workspace, '.scry', 'capture', 'uncertain')),
    logTail: logText.join('\n').trim().split('\n').slice(-12)
  }
}

async function ownerOf(workspace) {
  const marker = await readFile(join(workspace, '.scry', 'recorder-socket-path'), 'utf8').catch(() => undefined)
  if (!marker) return null
  const owner = JSON.parse(await readFile(`${marker.trim()}.owner.json`, 'utf8').catch(() => 'null'))
  return owner ? { pid: owner.pid, recorderVersion: owner.recorderVersion, state: owner.state } : null
}

async function stopDaemon(workspace, env) {
  await run(process.execPath, [cli, 'recorder', 'stop', '--workspace', workspace], { env }).catch(() => undefined)
}

async function coldWindow(runIndex) {
  const env = { ...process.env }
  delete env.SCRY_RECORDER_TRANSPORT
  const site = await makeWorkspace(`cold-${runIndex}`, cli, env)
  const session = `cold-session-${runIndex}`
  const base = { session_id: session, cwd: site.workspace, timestamp: new Date().toISOString() }
  const events = []
  events.push(await hook(site.script, 'UserPromptSubmit', { ...base, prompt: 'measure the cold window' }, site.env))
  const daemonMs = await daemonUp(site.workspace, site.env)
  events.push(await hook(site.script, 'PreToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'printf ok' }
  }, site.env))
  events.push(await hook(site.script, 'PostToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_response: 'ok'
  }, site.env))
  events.push(await hook(site.script, 'Stop', { ...base }, site.env))
  const summary = await recordSummary(site.workspace)
  const ownerPath = join(site.workspace, '.scry', 'recorder-socket-path')
  const socketMarker = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const owner = socketMarker ? JSON.parse(await readFile(`${socketMarker.trim()}.owner.json`, 'utf8').catch(() => 'null')) : null
  await stopDaemon(site.workspace, site.env)
  await sleep(200)
  return {
    run: runIndex,
    firstEventElapsedMs: events[0].elapsedMs,
    daemonUpMs: daemonMs,
    events: events.map(({ event, code, elapsedMs }) => ({ event, code, elapsedMs })),
    records: summary.records,
    health: summary.health,
    captureUncertain: summary.captureUncertain,
    daemonOwner: owner,
    logTail: summary.logTail,
    root: site.root
  }
}

async function warmWindow() {
  const env = { ...process.env }
  delete env.SCRY_RECORDER_TRANSPORT
  const site = await makeWorkspace('warm', cli, env)
  const session = 'warm-session'
  const base = { session_id: session, cwd: site.workspace, timestamp: new Date().toISOString() }
  const events = []
  events.push(await hook(site.script, 'UserPromptSubmit', { ...base, prompt: 'first turn' }, site.env))
  await daemonUp(site.workspace, site.env)
  events.push(await hook(site.script, 'PreToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'printf ok' }
  }, site.env))
  events.push(await hook(site.script, 'PostToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_response: 'ok'
  }, site.env))
  events.push(await hook(site.script, 'Stop', { ...base }, site.env))
  events.push(await hook(site.script, 'UserPromptSubmit', { ...base, prompt: 'second turn' }, site.env))
  events.push(await hook(site.script, 'Stop', { ...base }, site.env))
  const summary = await recordSummary(site.workspace)
  await stopDaemon(site.workspace, site.env)
  await sleep(200)
  return {
    events: events.map(({ event, code, elapsedMs }) => ({ event, code, elapsedMs })),
    records: summary.records,
    health: summary.health,
    logTail: summary.logTail,
    root: site.root
  }
}

async function twoHookSets(secondEntry) {
  const env = { ...process.env }
  delete env.SCRY_RECORDER_TRANSPORT
  const site = await makeWorkspace('two-hooks', cli, env)
  const second = join(site.root, 'hook-other.sh')
  await hookScript(second, secondEntry, site.workspace)
  const session = 'two-hook-session'
  const base = { session_id: session, cwd: site.workspace, timestamp: new Date().toISOString() }
  const events = []
  const owners = []
  const step = async (script, event, payload) => {
    const result = await hook(script, event, payload, site.env)
    const owner = await ownerOf(site.workspace)
    events.push({ ...result, owner })
    owners.push(owner?.recorderVersion ?? null)
    return result
  }
  await step(site.script, 'UserPromptSubmit', { ...base, prompt: 'two hook sets' })
  await daemonUp(site.workspace, site.env)
  await step(second, 'PreToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'printf ok' }
  })
  await step(second, 'PostToolUse', {
    ...base, tool_name: 'Bash', tool_use_id: 'tool-1', tool_response: 'ok'
  })
  await step(site.script, 'Stop', { ...base })
  await step(second, 'UserPromptSubmit', { ...base, prompt: 'second turn from the other hook' })
  await step(site.script, 'Stop', { ...base })
  const summary = await recordSummary(site.workspace)
  const markerPath = join(site.workspace, '.scry', 'recorder-socket-path')
  const socketMarker = await readFile(markerPath, 'utf8').catch(() => undefined)
  const owner = socketMarker ? JSON.parse(await readFile(`${socketMarker.trim()}.owner.json`, 'utf8').catch(() => 'null')) : null
  await stopDaemon(site.workspace, site.env)
  await sleep(200)
  return {
    events: events.map(({ event, code, elapsedMs, owner }) => ({ event, code, elapsedMs, ownerVersion: owner?.recorderVersion ?? null, ownerPid: owner?.pid ?? null })),
    records: summary.records,
    ownerVersionsSeen: [...new Set(owners.filter(Boolean))],
    daemonRestarts: new Set(events.map((item) => item.owner?.pid).filter(Boolean)).size,
    ownerVersions: owner ? [owner.recorderVersion] : [],
    daemonOwner: owner,
    logTail: summary.logTail,
    root: site.root
  }
}

async function secondRecorderEntry() {
  const copy = await mkdtemp(join(tmpdir(), 'scry-w23-recorder-copy-'))
  const target = join(copy, 'dist')
  await cp(join(repo, 'packages/turn-recorder-cli/dist'), target, { recursive: true })
  const storePath = join(target, 'core/turn-recorder/store.js')
  const source = await readFile(storePath, 'utf8')
  await writeFile(storePath, source.replace(/RECORDER_VERSION = '([0-9.]+)'/, "RECORDER_VERSION = '0.2.92'"))
  return join(target, 'cli/scry.js')
}

async function main() {
  if (!existsSync(cli)) throw new Error(`build the recorder CLI first: ${cli}`)
  await mkdir(outDir, { recursive: true })
  const cold = []
  for (let index = 1; index <= RUNS; index++) cold.push(await coldWindow(index))
  const warm = await warmWindow()
  const otherEntry = await secondRecorderEntry()
  const twoHooks = await twoHookSets(otherEntry)
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    recorderEntry: cli,
    recorderVersion: (await readFile(join(repo, 'packages/turn-recorder-cli/package.json'), 'utf8')).match(/"version": "([^"]+)"/)?.[1],
    cold,
    warm,
    twoHooks
  }
  const path = join(outDir, `cold-window-${Date.now()}.json`)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({
    evidence: path,
    cold: cold.map((item) => ({
      run: item.run,
      firstEventMs: item.firstEventElapsedMs,
      daemonUpMs: item.daemonUpMs,
      records: item.records.length,
      statuses: item.records.map((record) => record.status),
      captureUncertain: item.captureUncertain
    })),
    warm: { events: warm.events, records: warm.records.length },
    twoHooks: {
      records: twoHooks.records.length,
      versions: [...new Set(twoHooks.records.map((record) => record.recorderVersion))],
      ownerVersions: twoHooks.ownerVersions
    }
  }, null, 2))
  for (const item of [...cold, warm, twoHooks]) {
    console.error(`run data kept at ${item.root}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})