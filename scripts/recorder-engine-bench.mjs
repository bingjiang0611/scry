#!/usr/bin/env node
/**
 * Informational L1 benchmark for the recorder turn path and the Git snapshot engine.
 *
 * It always exits 0 once the CLI bundle exists: no thresholds, no assertions. Absolute numbers
 * move with machine, disk and load, so compare runs on one machine.
 *
 * What is counted, per stage (start / tool events / end / recovery / commit):
 *   - git subprocesses by subcommand, from a counting wrapper placed first on PATH
 *   - index bytes rewritten (full-index-per-rewrite estimate; enable with SCRY_BENCH_INDEX_BYTES=1)
 *   - transcript bytes read and anchor bytes scanned, from the recorder's process-local counters
 *   - hook return time and record-visible time, reported separately
 *   - peak RSS of the process that runs the hooks
 *
 * Hooks are driven in-process through `handleRecorderHook` (the direct write path), not through a
 * Provider or the daemon. That is deliberate: it isolates recorder work from Provider latency.
 *
 * Usage:
 *   npm run build:cli && node scripts/recorder-engine-bench.mjs --out=<file.json> [--only=S1,S4]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  commitAll, cleanupTemp, git, installGitProbe, loadDist, makeTempRoot, median, newRepo,
  recordFiles, resetRepo, startRssSampler, waitForRecord, workspaceRoot,
  writeRecorderConfig
} from './recorder-engine-bench-fixtures.mjs'

const args = process.argv.slice(2)
const only = (args.find((value) => value.startsWith('--only=')) ?? '').replace('--only=', '')
  .split(',').map((value) => value.trim()).filter(Boolean)
const outPath = (args.find((value) => value.startsWith('--out=')) ?? '').replace('--out=', '')
const rounds = Number(process.env.SCRY_BENCH_ROUNDS ?? 3)
const LARGE_FILES = Number(process.env.SCRY_BENCH_LARGE_FILES ?? 20_000)
const TRANSCRIPT_BYTES = Number(process.env.SCRY_BENCH_TRANSCRIPT_BYTES ?? 50 * 1024 * 1024)

const tempRoot = makeTempRoot()
const probe = installGitProbe(tempRoot)
const rss = startRssSampler()
const recorder = await loadDist('recorder')
const store = await loadDist('store')
const { handleRecorderHook, recoverRecorder, transcriptReadStats, resetTranscriptReadStats } = recorder
const { commitRecord, RECORDER_VERSION } = store

const environment = {
  platform: platform(), release: release(), arch: arch(), node: process.version,
  git: (await git(['--version'], tempRoot)).trim(),
  cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
  totalMemBytes: totalmem(), loadavg: loadavg(),
  probe: { gitWrapper: true, indexBytes: probe.indexBytesEnabled }
}

const results = []
const notes = []

async function stage(name, action) {
  resetTranscriptReadStats()
  rss.reset()
  const rssBefore = rss.read()
  probe.beginStage(name)
  const startedAt = process.hrtime.bigint()
  let value
  let error
  try { value = await action() } catch (caught) { error = caught }
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
  const git = probe.endStage()
  const transcript = transcriptReadStats()
  const rssAfter = rss.read()
  return {
    name,
    ...(error ? { error: String(error) } : {}),
    ms: round(ms),
    git,
    transcript,
    rssBeforeBytes: rssBefore.currentBytes,
    rssAfterBytes: rssAfter.currentBytes,
    peakRssBytes: rssAfter.peakBytes,
    ...(value === undefined ? {} : { value })
  }
}

function round(value) { return Math.round(value * 100) / 100 }

function payload(sessionId, extra = {}) {
  return { session_id: sessionId, timestamp: new Date().toISOString(), ...extra }
}

async function startTurn(root, sessionId, { prompt = 'implement the change', transcript } = {}) {
  return handleRecorderHook({
    provider: 'claude',
    event: 'UserPromptSubmit',
    workspace: root,
    payload: payload(sessionId, { prompt, cwd: root, ...(transcript ? { transcript_path: transcript } : {}) })
  })
}

async function toolCalls(root, sessionId, count) {
  for (let index = 0; index < count; index++) {
    const base = { tool_name: 'Bash', tool_use_id: `${sessionId}-tool-${index}`, cwd: root }
    await handleRecorderHook({
      provider: 'claude', event: 'PreToolUse:Bash', workspace: root,
      payload: payload(sessionId, { ...base, tool_input: { command: `printf step-${index}` } })
    })
    await handleRecorderHook({
      provider: 'claude', event: 'PostToolUse:Bash', workspace: root,
      payload: payload(sessionId, { ...base, tool_response: `step-${index} ok` })
    })
  }
}

async function stopTurn(root, sessionId, { transcript } = {}) {
  return handleRecorderHook({
    provider: 'claude',
    event: 'Stop',
    workspace: root,
    payload: payload(sessionId, { cwd: root, ...(transcript ? { transcript_path: transcript } : {}) })
  })
}

function dataRootOf(root) { return join(root, '.scry') }

/** One turn: start hook, optional work, optional tool events, stop hook, record visibility. */
async function runTurn(root, sessionId, options = {}) {
  const dataRoot = dataRootOf(root)
  const stages = []
  const before = await recordFiles(dataRoot)
  const startStage = await stage('start', () => startTurn(root, sessionId, options))
  stages.push(startStage)
  if (options.tools) stages.push(await stage('tool', () => toolCalls(root, sessionId, options.tools)))
  if (options.mutate) await options.mutate()
  const stopStage = await stage('end', () => stopTurn(root, sessionId, options))
  const visibleMs = await waitForRecord(dataRoot, before)
  stopStage.recordVisibleMs = visibleMs
  stopStage.hookReturnMs = stopStage.ms
  stages.push(stopStage)
  stages.push({ name: 'record-visible', ms: visibleMs })
  return stages
}

function gitTotals(stages) {
  const byCommand = {}
  let total = 0
  let indexBytes = 0
  for (const entry of stages) {
    if (!entry.git) continue
    total += entry.git.total
    indexBytes += entry.git.indexBytes ?? 0
    for (const [command, count] of Object.entries(entry.git.byCommand)) {
      byCommand[command] = (byCommand[command] ?? 0) + count
    }
  }
  return { total, byCommand, indexBytes }
}

async function record(id, title, body) {
  if (only.length > 0 && !only.includes(id)) return
  process.stderr.write(`running ${id}: ${title}\n`)
  const startedAt = Date.now()
  try {
    const value = await body()
    results.push({ id, title, ...value, wallMs: Date.now() - startedAt })
  } catch (error) {
    results.push({ id, title, error: String(error), wallMs: Date.now() - startedAt })
    notes.push(`${id} failed: ${String(error)}`)
    process.stderr.write(`  ${id} failed: ${String(error)}\n`)
  }
}

// --- scenarios -------------------------------------------------------------------------------

async function largeRepo() {
  if (!largeRepos.has('large')) {
    const root = await workspaceRoot(tempRoot, 'large')
    await writeRecorderConfig(root, { workspaceId: 'bench-large' })
    await newRepo(root, { files: LARGE_FILES })
    largeRepos.set('large', root)
  }
  return largeRepos.get('large')
}
const largeRepos = new Map()

/** Single-repository workspace: the workspace root is the Git worktree and the config is committed. */
async function smallWorkspace(label, { files = 100 } = {}) {
  const root = await workspaceRoot(tempRoot, label)
  await writeRecorderConfig(root, { workspaceId: label })
  await newRepo(root, { files })
  return root
}

await record('S1', 'small repo, clean baseline, one file changed', async () => {
  const stages = []
  for (let round = 0; round < rounds; round++) {
    const root = await smallWorkspace(`s1-${round}`)
    stages.push(...await runTurn(root, `s1-session-${round}`, {
      mutate: () => writeFile(join(root, 'src', 'f0.ts'), 'export const changed = true\n')
    }))
    await rm(root, { recursive: true, force: true })
  }
  return { stages, git: gitTotals(stages) }
})

await record('S2', 'large repo (20k tracked), clean baseline, one file changed', async () => {
  const root = await largeRepo()
  const stages = []
  for (let round = 0; round < rounds; round++) {
    await resetRepo(root)
    stages.push(...await runTurn(root, `s2-session-${round}`, {
      mutate: () => writeFile(join(root, 'src', 'f0.ts'), `export const changed = ${round}\n`)
    }))
  }
  return { stages, git: gitTotals(stages), fixture: { trackedFiles: LARGE_FILES } }
})

await record('S3', 'large repo, dirty baseline (50 modified before the turn)', async () => {
  const root = await largeRepo()
  const stages = []
  for (let round = 0; round < rounds; round++) {
    await resetRepo(root)
    for (let index = 0; index < 50; index++) {
      await writeFile(join(root, 'src', `f${index}.ts`), `export const dirty${index} = ${round}\n`)
    }
    stages.push(...await runTurn(root, `s3-session-${round}`, {
      mutate: () => writeFile(join(root, 'src', 'f100.ts'), `export const changed = ${round}\n`)
    }))
  }
  return { stages, git: gitTotals(stages), fixture: { dirtyBeforeTurn: 50, trackedFiles: LARGE_FILES } }
})

await record('S4', 'large repo, 300 small files changed in the turn', async () => {
  const root = await largeRepo()
  const stages = []
  for (let round = 0; round < rounds; round++) {
    await resetRepo(root)
    stages.push(...await runTurn(root, `s4-session-${round}`, {
      mutate: async () => {
        for (let index = 0; index < 300; index++) {
          await writeFile(join(root, 'src', `f${index}.ts`), `export const touched${index} = ${round}\n`)
        }
      }
    }))
  }
  return { stages, git: gitTotals(stages), fixture: { changedFiles: 300 } }
})

await record('S5', 'one 50 MB text file changed (peak RSS)', async () => {
  const root = await smallWorkspace('s5', { files: 50 })
  await writeFile(join(root, 'big.txt'), 'a\n'.repeat(64 * 1024 * 512))
  await commitAll(root)
  const stages = []
  for (let round = 0; round < rounds; round++) {
    const body = Buffer.alloc(50 * 1024 * 1024, 'b')
    stages.push(...await runTurn(root, `s5-session-${round}`, {
      mutate: () => writeFile(join(root, 'big.txt'), body)
    }))
    await resetRepo(root)
  }
  return { stages, git: gitTotals(stages), fixture: { changedFileBytes: 50 * 1024 * 1024 } }
})

await record('S6', '18 nested repositories, 3 changed', async () => {
  const root = await workspaceRoot(tempRoot, 's6')
  await writeRecorderConfig(root, { workspaceId: 's6', mode: 'discover-nested-git', maxDepth: 2 })
  for (let index = 0; index < 18; index++) await newRepo(join(root, `repo-${index}`), { files: 20 })
  const stages = []
  for (let round = 0; round < rounds; round++) {
    stages.push(...await runTurn(root, `s6-session-${round}`, {
      mutate: async () => {
        for (const index of [0, 7, 13]) {
          await writeFile(join(root, `repo-${index}`, 'src', 'f0.ts'), `export const r = ${round}\n`)
        }
      }
    }))
    for (const index of [0, 7, 13]) await resetRepo(join(root, `repo-${index}`))
    await rm(dataRootOf(root), { recursive: true, force: true })
  }
  return { stages, git: gitTotals(stages), fixture: { repositories: 18, changed: 3 } }
})

await record('S7', '30 tool calls (60 events), no file changes', async () => {
  const root = await smallWorkspace('s7', { files: 100 })
  const dataRoot = dataRootOf(root)
  const stages = []
  for (let round = 0; round < rounds; round++) {
    await rm(dataRoot, { recursive: true, force: true })
    await writeRecorderConfig(root, { workspaceId: 's7' })
    const before = await recordFiles(dataRoot)
    stages.push(await stage('start', () => startTurn(root, `s7-${round}`)))
    stages.push(await stage('tool', () => toolCalls(root, `s7-${round}`, 30)))
    const stop = await stage('end', () => stopTurn(root, `s7-${round}`))
    stop.recordVisibleMs = await waitForRecord(dataRoot, before)
    stages.push(stop)
  }
  return { stages, git: gitTotals(stages) }
})

async function buildTranscript(path, bytes) {
  const chunk = 'x'.repeat(1024)
  const lines = ['{"type":"user","message":{"role":"user","content":"long session prompt"}}']
  let written = lines[0].length
  let index = 0
  while (written < bytes) {
    const line = JSON.stringify({
      type: index % 3 === 0 ? 'assistant' : 'progress',
      message: { role: 'assistant', content: [{ type: 'text', text: `${index}:${chunk}` }] },
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 3600)).toISOString()
    })
    lines.push(line)
    written += line.length + 1
    index++
  }
  await writeFile(path, `${lines.join('\n')}\n`)
  return written
}

await record('S8', 'long transcript (50 MB) turn end', async () => {
  const root = await smallWorkspace('s8', { files: 20 })
  const stages = []
  for (let round = 0; round < rounds; round++) {
    const transcript = join(root, `transcript-${round}.jsonl`)
    const bytes = await buildTranscript(transcript, TRANSCRIPT_BYTES)
    await rm(dataRootOf(root), { recursive: true, force: true })
    await writeRecorderConfig(root, { workspaceId: 's8' })
    const before = await recordFiles(dataRootOf(root))
    stages.push(await stage('start', () => startTurn(root, `s8-${round}`, { prompt: 'long session prompt', transcript })))
    const stop = await stage('end', () => stopTurn(root, `s8-${round}`, { transcript }))
    stop.recordVisibleMs = await waitForRecord(dataRootOf(root), before)
    stages.push(stop)
    await rm(transcript, { force: true })
    stages[stages.length - 1].fixture = { transcriptBytes: bytes }
  }
  return { stages, git: gitTotals(stages), fixture: { transcriptBytes: TRANSCRIPT_BYTES } }
})

function draftFor(root, index) {
  const empty = { status: 'available', quality: 'exact', source: ['fixture'], value: [] }
  return {
    schemaVersion: 1, recordKind: 'agent_turn',
    recordId: `bench${index}`.padEnd(32, '0').slice(0, 32).replace(/[^a-f0-9]/g, 'a'),
    recorderVersion: RECORDER_VERSION, workspace: { id: 'bench', root }, provider: { id: 'claude' },
    sessionId: `seed-${index}`, generation: 1, turnIndex: 1,
    startedAt: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-01T00:00:01.000Z', durationMs: 1000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'seed' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: `seed ${index}` } },
    tools: empty, skills: empty, mcps: empty, hooks: empty, files: empty, diff: empty,
    dangerousOperations: empty, errors: empty, usage: { status: 'unavailable', quality: 'unavailable', source: [] }
  }
}

await record('S9', 'commit one record with 0 / 1000 / 10000 existing records', async () => {
  const stages = []
  for (const history of [0, 1_000, 10_000]) {
    const dataRoot = join(tempRoot, `s9-${history}`, '.scry')
    await mkdir(dataRoot, { recursive: true })
    for (let index = 0; index < history; index++) await commitRecord(dataRoot, draftFor(tempRoot, index))
    const samples = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await stage('commit', () => commitRecord(dataRoot, draftFor(tempRoot, history + attempt)))
      samples.push(result)
    }
    stages.push({
      name: 'commit',
      history,
      ms: median(samples.map((sample) => sample.ms)),
      git: gitTotals(samples),
      samples: samples.map((sample) => sample.ms),
      peakRssBytes: samples.at(-1).peakRssBytes
    })
  }
  return { stages, fixture: { recordsHistories: [0, 1_000, 10_000] } }
})

await record('S10', '4 concurrent sessions x 5 turns on one workspace', async () => {
  const root = await smallWorkspace('s10', { files: 100 })
  const stages = []
  for (let round = 0; round < rounds; round++) {
    await rm(dataRootOf(root), { recursive: true, force: true })
    await writeRecorderConfig(root, { workspaceId: 's10' })
    const before = await recordFiles(dataRootOf(root))
    stages.push(await stage('concurrent', async () => {
      await Promise.all([0, 1, 2, 3].map(async (session) => {
        for (let turn = 0; turn < 5; turn++) {
          await startTurn(root, `s10-${session}`)
          await toolCalls(root, `s10-${session}`, 2)
          await stopTurn(root, `s10-${session}`)
        }
      }))
    }))
    const visibleMs = await waitForRecord(dataRootOf(root), before + 19)
    stages[stages.length - 1].recordVisibleMs = visibleMs
    stages[stages.length - 1].records = await recordFiles(dataRootOf(root))
  }
  return { stages, git: gitTotals(stages), fixture: { sessions: 4, turnsEach: 5 } }
})

await record('S11', 'recovery with 1000 completed session directories', async () => {
  const root = await smallWorkspace('s11', { files: 20 })
  const stages = []
  for (let round = 0; round < rounds; round++) {
    const runtime = join(dataRootOf(root), 'runtime', 'claude')
    await rm(runtime, { recursive: true, force: true })
    for (let index = 0; index < 1_000; index++) await mkdir(join(runtime, `done-session-${index}`), { recursive: true })
    // One genuinely unfinished turn that recovery must still find and commit.
    await startTurn(root, `s11-open-${round}`, { prompt: 'unfinished turn' })
    stages.push(await stage('recovery', () => recoverRecorder(root)))
    stages[stages.length - 1].sessionDirs = 1_000
  }
  return { stages, git: gitTotals(stages), fixture: { completedSessionDirs: 1_000 } }
})

// --- report ----------------------------------------------------------------------------------

probe.stop()
rss.stop()
const report = { schema: 1, generatedAt: new Date().toISOString(), environment, rounds, results, notes }
if (outPath) {
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)
}

function formatCounts(gitCount) {
  const entries = Object.entries(gitCount.byCommand ?? {}).sort((left, right) => right[1] - left[1])
  return entries.map(([command, count]) => `${command}:${count}`).join(' ') || '-'
}

process.stdout.write(`recorder engine L1 bench, ${rounds} rounds/scenario, ${platform()} ${process.version}\n\n`)
for (const result of results) {
  if (result.error) {
    process.stdout.write(`${result.id}  ${result.title}\n  FAILED: ${result.error}\n\n`)
    continue
  }
  process.stdout.write(`${result.id}  ${result.title}\n`)
  for (const entry of result.stages) {
    if (entry.name === 'record-visible') continue
    const extra = entry.history === undefined ? '' : ` history=${entry.history}`
    const transcriptBytes = entry.transcript
      ? ` parse=${entry.transcript.bytesRead}B anchor=${entry.transcript.anchorBytesScanned}B`
      : ''
    const visible = entry.recordVisibleMs === undefined || entry.recordVisibleMs === null
      ? '' : ` recordVisible=${Math.round(entry.recordVisibleMs)}ms`
    process.stdout.write(
      `  ${entry.name.padEnd(11)} ms=${String(Math.round(entry.ms)).padStart(6)}${extra}` +
      ` git=${String(entry.git?.total ?? 0).padStart(3)} [${formatCounts(entry.git ?? {})}]` +
      `${entry.git?.indexBytes ? ` idx≈${entry.git.indexBytes}B` : ''}${transcriptBytes}${visible}` +
      `${entry.peakRssBytes ? ` rss=${Math.round(entry.peakRssBytes / 1024 / 1024)}MB` : ''}\n`
    )
  }
  process.stdout.write(`  total git=${result.git?.total ?? '-'}  wall=${Math.round(result.wallMs / 1000)}s\n\n`)
}
if (notes.length > 0) process.stdout.write(`notes:\n${notes.map((note) => `  ${note}`).join('\n')}\n`)
if (outPath) process.stdout.write(`json: ${outPath}\n`)

cleanupTemp(tempRoot)
process.exit(0)
