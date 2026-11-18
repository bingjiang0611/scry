#!/usr/bin/env node
/** L2 socket harness, not a real host. No production state or callback configuration is used.
 * node scripts/recorder-daemon-cpu-bench.mjs --package-root=/path/to/package --seconds=600 --out=/tmp/result.json
 * CPU is this process's user+system time (daemon + small socket client), excluding Git children.
 * --profile writes a V8 CPU profile alongside the report. History is synthetic, outside the repo.
 */
import assert from 'node:assert/strict'
import { Session } from 'node:inspector/promises'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, loadavg, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const packageRoot = resolve(options['package-root'] ?? 'packages/turn-recorder-cli')
const seconds = Number(options.seconds ?? 600)
const history = Number(options.history ?? 200)
const transcriptMiB = Number(options['transcript-mib'] ?? 32)
assert(seconds > 0 && history >= 0 && transcriptMiB > 0)
const output = resolve(options.out ?? '/tmp/recorder-daemon-cpu.json')
const load = name => import(pathToFileURL(join(packageRoot, 'dist/core/turn-recorder', `${name}.js`)).href)
const { listenRecorderDaemon, sendRecorderDaemonHook } = await load('daemon')
const { handleRecorderHook, recoverRecorder, resetTranscriptReadStats, transcriptReadStats } = await load('recorder')
const { listRecords, RECORDER_VERSION } = await load('store')
const root = await mkdtemp(join(tmpdir(), 'scry-daemon-cpu-'))
const env = { PATH: process.env.PATH, HOME: root, SCRY_RECORDER_SOCKET: join(root, 'r.sock') }
const transcript = join(root, 'codex.jsonl')
let daemon
let inspector
const runtimeHash = createHash('sha256')
async function hashRuntime(directory, relative = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${relative}${entry.name}`
    if (entry.isDirectory()) await hashRuntime(join(directory, entry.name), `${name}/`)
    else if (entry.name.endsWith('.js')) runtimeHash.update(name).update('\0').update(await readFile(join(directory, entry.name))).update('\0')
  }
}
await hashRuntime(join(packageRoot, 'dist'))
const report = {
  version: RECORDER_VERSION, packageRoot, runtimeSha256: runtimeHash.digest('hex'), seconds, history, transcriptMiB,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model, load: loadavg() },
  scope: 'L2 synthetic socket harness; self CPU excludes Git children; no real host or upload'
}
const cpuMs = start => { const usage = process.cpuUsage(start); return (usage.user + usage.system) / 1000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'cpu-fixture', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const padding = JSON.stringify({ type: 'ignored_fixture', data: 'x'.repeat(4000) }) + '\n'
  await writeFile(transcript, padding.repeat(Math.ceil(transcriptMiB * 1024 * 1024 / Buffer.byteLength(padding))) +
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'idle-turn' } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'idle prompt' } }) + '\n')
  await handleRecorderHook({ workspace: root, provider: 'codex', event: 'UserPromptSubmit', env,
    payload: { session_id: 'idle-session', turn_id: 'idle-turn', prompt: 'idle prompt', transcript_path: transcript } })
  const sessions = await readdir(join(root, '.scry/runtime/codex'))
  const session = join(root, '.scry/runtime/codex', sessions[0])
  for (let i = 0; i < history; i++) await mkdir(join(session, 'turns', `committed-history-${i}`), { recursive: true })
  await recoverRecorder(root, env)
  daemon = await listenRecorderDaemon({ workspace: root, env, idleMs: 30 * 60_000 })
  if ('profile' in options) {
    inspector = new Session(); inspector.connect()
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.setSamplingInterval', { interval: 10000 })
    await inspector.post('Profiler.start')
  }
  resetTranscriptReadStats()
  const idleStart = process.cpuUsage()
  const wallStart = performance.now()
  await sleep(seconds * 1000)
  report.idle = { cpuMs: cpuMs(idleStart), wallMs: performance.now() - wallStart, transcript: transcriptReadStats() }
  report.idle.corePercent = report.idle.cpuMs / report.idle.wallMs * 100
  if (inspector) {
    const { profile } = await inspector.post('Profiler.stop')
    await writeFile(`${output}.cpuprofile`, JSON.stringify(profile))
    inspector.disconnect(); inspector = undefined
  }
  // One representative captured turn: prompt, ten tool start/end pairs, answer, Stop.
  resetTranscriptReadStats()
  const sessionStart = process.cpuUsage()
  const sessionWall = performance.now()
  const send = (event, extra) => sendRecorderDaemonHook({ workspace: root, env, provider: 'pi', event,
    payload: { session_id: 'typical-session', promptId: 'typical-turn', ...extra } })
  await send('UserPromptSubmit', { prompt: 'implement one small change' })
  for (let i = 0; i < 10; i++) {
    await send('PreToolUse', { tool_name: 'Bash', tool_use_id: `tool-${i}`, tool_input: { command: `printf step-${i}` } })
    await send('PostToolUse', { tool_name: 'Bash', tool_use_id: `tool-${i}`, tool_response: `step-${i}` })
  }
  await send('Stop', { assistant_response: 'implemented the small change' })
  report.session = { cpuMs: cpuMs(sessionStart), wallMs: performance.now() - sessionWall, events: 22, transcript: transcriptReadStats() }
  const records = await listRecords(join(root, '.scry'))
  assert.equal(records.filter(r => r.sessionId === 'typical-session' && r.status === 'completed').length, 1)
  // No hook: an appended native terminal must still converge through the daemon's recovery timer.
  await appendFile(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'task_complete', turn_id: 'idle-turn', last_agent_message: 'finished' } }) + '\n')
  const deadline = Date.now() + 60_000
  while (!(await listRecords(join(root, '.scry'))).some(r => r.sessionId === 'idle-session') && Date.now() < deadline) await sleep(100)
  assert.equal((await listRecords(join(root, '.scry'))).filter(r => r.sessionId === 'idle-session' && r.status === 'completed').length, 1)
  report.checks = { typicalTurnExactlyOnce: true, terminalWithoutHookRecovered: true }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  inspector?.disconnect()
  await daemon?.close()
  await rm(root, { recursive: true, force: true })
}
