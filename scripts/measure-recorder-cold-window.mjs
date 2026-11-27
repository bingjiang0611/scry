#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
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
const releaseVersion = process.env.SCRY_W23_RELEASE_VERSION ?? '0.2.94'
const only = process.env.SCRY_W23_ONLY ?? ''

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
  const health = await readFile(join(workspace, '.scry', 'health.json'), 'utf8').catch(() => undefined)
  const logs = await readdir(join(workspace, '.scry', 'logs')).catch(() => [])
  const logText = []
  for (const name of logs) {
    if (!name.startsWith('recorder.log')) continue
    logText.push(await readFile(join(workspace, '.scry', 'logs', name), 'utf8').catch(() => ''))
  }
  const skipLog = await readFile(join(workspace, '.scry', 'logs', 'hook-skip.log'), 'utf8').catch(() => '')
  const inbox = await queuedEntries(join(workspace, '.scry', 'runtime'))
  return {
    records,
    health: health ? JSON.parse(health) : null,
    hookSkips: skipLog.trim() ? skipLog.trim().split('\n').length : 0,
    queuedForReplay: inbox.length,
    logTail: logText.join('\n').trim().split('\n').slice(-12)
  }
}

async function queuedEntries(dir) {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const entry of names) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await queuedEntries(path))
    else if (entry.name.endsWith('.json') && dir.endsWith('inbox')) found.push(path)
  }
  return found
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
    hookSkips: summary.hookSkips,
    queuedForReplay: summary.queuedForReplay,
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

async function twoHookSets(newEntry, secondEntry, oldFirst = false) {
  const env = { ...process.env }
  delete env.SCRY_RECORDER_TRANSPORT
  const site = await makeWorkspace('two-hooks', oldFirst ? secondEntry : newEntry, env)
  const second = join(site.root, 'hook-other.sh')
  await hookScript(second, oldFirst ? newEntry : secondEntry, site.workspace)
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
  if (env.SCRY_W23_PREWARM === 'old' || env.SCRY_W23_PREWARM === 'new') {
    await run(process.execPath, [env.SCRY_W23_PREWARM === 'old' ? secondEntry : newEntry, 'recorder', 'start', '--workspace', site.workspace], { env: site.env })
  }
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

async function stampVersion(entry, version) {
  const dist = join(dirname(resolve(entry)), '..')
  const copy = await mkdtemp(join(tmpdir(), 'scry-w23-stamped-'))
  await cp(dist, join(copy, 'dist'), { recursive: true })
  const storePath = join(copy, 'dist/core/turn-recorder/store.js')
  const source = await readFile(storePath, 'utf8')
  if (!/RECORDER_VERSION = '[0-9.]+'/.test(source)) throw new Error(`cannot stamp a version into ${storePath}`)
  await writeFile(storePath, source.replace(/RECORDER_VERSION = '[0-9.]+'/, `RECORDER_VERSION = '${version}'`))
  return join(copy, 'dist/cli/scry.js')
}

async function oldRecorderEntry() {
  const entry = process.env.SCRY_W23_OLD_CLI
  if (!entry) throw new Error('set SCRY_W23_OLD_CLI to a recorder CLI built from main (0.2.93)')
  const dist = join(dirname(resolve(entry)), '..')
  const store = await readFile(join(dist, 'core/turn-recorder/store.js'), 'utf8')
  const version = store.match(/RECORDER_VERSION = '([0-9.]+)'/)?.[1]
  const patched = await access(join(dist, 'core/turn-recorder/recorder-version-order.js')).then(() => true, () => false)
  if (patched) throw new Error(`${entry} ships recorder-version-order, so it is not the build main released`)
  if (version !== '0.2.93') throw new Error(`${entry} reports ${version}, expected the released 0.2.93`)
  return { entry, version }
}

async function startReplacement(newEntry, oldEntry, first) {
  const env = { ...process.env }
  delete env.SCRY_RECORDER_TRANSPORT
  const site = await makeWorkspace('old-start', newEntry, env)
  await run(process.execPath, [first === 'old' ? oldEntry : newEntry, 'recorder', 'start', '--workspace', site.workspace], { env: site.env })
  const marker = join(site.workspace, '.scry', 'recorder-socket-path')
  const before = JSON.parse(await readFile(`${(await readFile(marker, 'utf8')).trim()}.owner.json`, 'utf8'))
  const started = await run(process.execPath, [first === 'old' ? newEntry : oldEntry, 'recorder', 'start', '--workspace', site.workspace], { env: site.env })
    .then(() => true, (error) => String(error?.stderr ?? error))
  await sleep(400)
  const after = JSON.parse(await readFile(`${(await readFile(marker, 'utf8')).trim()}.owner.json`, 'utf8'))
  await stopDaemon(site.workspace, site.env)
  await sleep(200)
  return { before: { version: before.recorderVersion, pid: before.pid }, after: { version: after.recorderVersion, pid: after.pid }, started, root: site.root }
}

async function main() {
  if (!existsSync(cli)) throw new Error(`build the recorder CLI first: ${cli}`)
  await mkdir(outDir, { recursive: true })
  const newEntry = await stampVersion(process.env.SCRY_W23_NEW_CLI ?? cli, releaseVersion)
  const old = await oldRecorderEntry()
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    newEntry,
    releaseVersion,
    oldEntry: old.entry,
    oldVersion: old.version,
    cold: [],
    warm: undefined,
    twoHooks: undefined
  }
  if (only === 'oldStart' || only === 'newStart') {
    const first = only === 'oldStart' ? 'new' : 'old'
    const result = await startReplacement(newEntry, old.entry, first)
    const path = join(outDir, `start-replacement-${only}-${Date.now()}.json`)
    await writeFile(path, `${JSON.stringify({ measuredAt: new Date().toISOString(), oldVersion: old.version, releaseVersion, ...result }, null, 2)}\n`)
    console.log(JSON.stringify({ evidence: path, mode: only, ...result }, null, 2))
    return
  }
  if (only === 'oldFirst') {
    const result = await twoHookSets(newEntry, old.entry, true)
    const path = join(outDir, `old-first-${Date.now()}.json`)
    await writeFile(path, `${JSON.stringify({ measuredAt: new Date().toISOString(), oldVersion: old.version, releaseVersion, twoHooks: result }, null, 2)}\n`)
    console.log(JSON.stringify({ evidence: path, records: result.records.length, ownerVersionsSeen: result.ownerVersionsSeen,
      daemonRestarts: result.daemonRestarts, events: result.events.map((e) => [e.event, e.ownerVersion]) }, null, 2))
    return
  }
  if (only !== 'twoHooks') {
    for (let index = 1; index <= RUNS; index++) {
      report.cold.push(await coldWindow(index))
      console.error(`cold run ${index} done`)
    }
    report.warm = await warmWindow()
  }
  report.twoHooks = await twoHookSets(newEntry, old.entry)
  if (only === 'twoHooksAgain') report.twoHooksOldFirst = await twoHookSets(newEntry, old.entry, true)
  const path = join(outDir, `cold-window-${Date.now()}.json`)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({
    evidence: path,
    oldVersion: old.version,
    releaseVersion,
    cold: report.cold.map((item) => ({
      run: item.run,
      firstEventMs: item.firstEventElapsedMs,
      daemonUpMs: item.daemonUpMs,
      records: item.records.length,
      statuses: item.records.map((record) => record.status),
      hookSkips: item.hookSkips,
      queuedForReplay: item.queuedForReplay
    })),
    warm: report.warm ? { events: report.warm.events, records: report.warm.records.length } : null,
    twoHooks: {
      records: report.twoHooks.records.length,
      ownerVersions: report.twoHooks.ownerVersions,
      ownerVersionsSeen: report.twoHooks.ownerVersionsSeen,
      daemonRestarts: report.twoHooks.daemonRestarts,
      events: report.twoHooks.events.map((item) => ({ event: item.event, code: item.code, elapsedMs: item.elapsedMs, ownerVersion: item.ownerVersion }))
    }
  }, null, 2))
  for (const item of [report.twoHooks]) console.error(`run data kept at ${item.root}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})