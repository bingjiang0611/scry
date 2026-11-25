#!/usr/bin/env node
/** L2 harness, not a real host: no daemon, no upload, no host hooks, nothing written outside a temp
 * workspace (or the workspace copy given by --workspace).
 * node scripts/recorder-quiet-revisit-bench.mjs --mode=visit|defer --sessions=45 --transcript-kb=64 --passes=20
 * node scripts/recorder-quiet-revisit-bench.mjs --mode=defer --workspace=/tmp/copied-store --passes=10
 *
 * CPU is this process's user+system time for one recovery pass, excluding any Git children.
 * `visit` touches each session's open state between passes, so every pass re-judges everything -
 * that is what a recovery pass did before quiet sessions were deferred. `defer` leaves the files
 * alone, so only the first pass pays for a verdict it will not reach.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { arch, cpus, loadavg, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const mode = options.mode ?? 'defer'
const passes = Number(options.passes ?? 20)
const sessions = Number(options['sessions'] ?? 45)
const transcriptKb = Number(options['transcript-kb'] ?? 64)
const packageRoot = resolve(options['package-root'] ?? 'packages/turn-recorder-cli')
const output = resolve(options.out ?? '/tmp/recorder-quiet-revisit.json')
assert(['visit', 'defer'].includes(mode), '--mode must be visit or defer')
assert(passes > 1 && sessions > 0 && transcriptKb > 0)
const load = name => import(pathToFileURL(join(packageRoot, 'dist/core/turn-recorder', `${name}.js`)).href)
const { handleRecorderHook, recoverRecorder, resetTranscriptReadStats, transcriptReadStats } = await load('recorder')
const { RECORDER_VERSION } = await load('store')

const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000)

/** One session per turn, planted through the real hook path so the opening state is not invented. */
async function fixture(root) {
  const env = { PATH: process.env.PATH, HOME: root, SCRY_RECORDER_SOCKET: join(root, 'r.sock') }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'quiet-revisit-bench', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const filler = 'x'.repeat(Math.max(0, transcriptKb * 1024 - 400))
  const at = minutesAgo(120).toISOString()
  for (let index = 0; index < sessions; index++) {
    const sessionId = `quiet-${index}`
    const transcript = join(root, `${sessionId}.jsonl`)
    await writeFile(transcript, [
      JSON.stringify({ type: 'user', timestamp: at, promptId: 'prompt-1', requestSetId: 'request-1', message: { role: 'user', content: `task ${index}` } }),
      // A reply that stopped to call a tool: nothing terminal will ever arrive for this turn.
      JSON.stringify({ type: 'assistant', timestamp: at, promptId: 'prompt-1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: filler }] } })
    ].join('\n') + '\n')
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root, env,
      payload: { session_id: sessionId, prompt: `task ${index}`, transcript_path: transcript, request_set_id: 'request-1', timestamp: at }
    })
  }
  return env
}

/** Backdates recovery fixture timestamps by two hours to model inactive sessions. */
async function backdate(root) {
  const at = minutesAgo(120)
  const touch = path => utimes(path, at, at).catch(() => undefined)
  for (const provider of await readdir(join(root, '.scry', 'runtime')).catch(() => [])) {
    for (const session of await readdir(join(root, '.scry', 'runtime', provider)).catch(() => [])) {
      const sessionDir = join(root, '.scry', 'runtime', provider, session)
      for (const name of await readdir(sessionDir).catch(() => [])) await touch(join(sessionDir, name))
      await touch(sessionDir)
      for (const turn of await readdir(join(sessionDir, 'turns')).catch(() => [])) {
        await touch(join(sessionDir, 'turns', turn, 'events'))
        await touch(join(sessionDir, 'turns', turn, 'pending-open.json'))
        await touch(join(sessionDir, 'turns', turn))
      }
      await touch(join(sessionDir, 'turns'))
    }
  }
  for (const name of await readdir(root)) {
    if (name.endsWith('.jsonl')) await touch(join(root, name))
  }
}

/** Refreshes open-state timestamps between visit-mode passes without changing file contents. */
async function nudge(root) {
  const at = new Date()
  for (const provider of await readdir(join(root, '.scry', 'runtime')).catch(() => [])) {
    for (const session of await readdir(join(root, '.scry', 'runtime', provider)).catch(() => [])) {
      await utimes(join(root, '.scry', 'runtime', provider, session, 'open.json'), at, at).catch(() => undefined)
    }
  }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const temp = options.workspace ? undefined : await mkdtemp(join(tmpdir(), 'scry-quiet-revisit-'))
const root = options.workspace ? resolve(options.workspace) : temp
try {
  const env = options.workspace
    ? { PATH: process.env.PATH, HOME: join(root, '.bench-home'), SCRY_RECORDER_SOCKET: join(root, '.bench-home', 'r.sock') }
    : await fixture(root)
  if (options.workspace) await mkdir(env.HOME, { recursive: true })
  await backdate(root)

  const samples = []
  for (let pass = 0; pass < passes; pass++) {
    if (mode === 'visit' && pass > 0) await nudge(root)
    resetTranscriptReadStats()
    const before = process.cpuUsage()
    const started = performance.now()
    const result = await recoverRecorder(root, env, undefined, undefined, { incremental: true })
    const usage = process.cpuUsage(before)
    samples.push({
      pass: pass + 1,
      cpuMs: (usage.user + usage.system) / 1000,
      wallMs: performance.now() - started,
      transcriptMiB: transcriptReadStats().bytesRead / 1024 / 1024,
      recovered: result.recovered,
      pending: result.pending
    })
  }
  const steady = samples.slice(1)
  const pollSeconds = 15
  const report = {
    version: RECORDER_VERSION, mode, sessions, transcriptKb, passes,
    workspace: options.workspace ? root : 'synthetic',
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model, load: loadavg() },
    scope: 'L2 single-pass harness; self CPU only; no daemon, no upload, no real host hooks',
    cold: samples[0],
    steady: {
      medianCpuMs: median(steady.map(sample => sample.cpuMs)),
      medianWallMs: median(steady.map(sample => sample.wallMs)),
      medianTranscriptMiB: median(steady.map(sample => sample.transcriptMiB)),
      totalCpuMs: steady.reduce((sum, sample) => sum + sample.cpuMs, 0),
      projectedCpuPercentAtPollInterval: (median(steady.map(sample => sample.cpuMs)) / 1000) / pollSeconds * 100
    },
    samples
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${mode}: cold ${report.cold.wallMs.toFixed(0)}ms / ${report.cold.cpuMs.toFixed(1)}ms CPU, `
    + `steady ${report.steady.medianWallMs.toFixed(1)}ms wall / ${report.steady.medianCpuMs.toFixed(2)}ms CPU `
    + `(${report.steady.medianTranscriptMiB.toFixed(2)} MiB read, ${report.steady.projectedCpuPercentAtPollInterval.toFixed(3)}% at ${pollSeconds}s poll)`)
  console.log(`report: ${output}`)
} finally {
  if (temp) await rm(temp, { recursive: true, force: true })
}
