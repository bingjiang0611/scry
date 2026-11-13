#!/usr/bin/env node
/**
 * Fixtures and L1 counters shared by `scripts/recorder-engine-bench.mjs`.
 *
 * Everything here is informational: no thresholds, no assertions. The one hard rule is that the
 * probe must not change what the recorder does. Git subprocesses are counted by putting a wrapper
 * named `git` first on PATH; the wrapper only appends its argv (and optionally the size of
 * GIT_INDEX_FILE it was handed) and then execs the real binary, so exit codes, signals and
 * deadlines behave exactly as without the probe.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const exec = promisify(execFile)

export const repoDist = new URL('../packages/turn-recorder-cli/dist/core/turn-recorder/', import.meta.url)

export async function loadDist(name) {
  return import(new URL(`${name}.js`, repoDist).href)
}

const FIXTURE_ENV = { ...process.env }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete FIXTURE_ENV[key]
Object.assign(FIXTURE_ENV, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: '' })

export const gitEnv = FIXTURE_ENV

export async function git(args, cwd, env = FIXTURE_ENV) {
  const { stdout } = await exec('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const COMMIT = ['-c', 'user.name=bench', '-c', 'user.email=bench@scry.local', '-c', 'commit.gpgsign=false']

export async function commitAll(cwd, message = 'bench') {
  await git(['add', '-A'], cwd)
  await git([...COMMIT, 'commit', '-q', '-m', message], cwd)
  return (await git(['rev-parse', 'HEAD'], cwd)).trim()
}

/** Root directory for every temporary fixture of this run; removed by `cleanupTemp`. */
export function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'scry-recorder-engine-'))
}

export function cleanupTemp(tempRoot) {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      execFileSync('test', ['-x', candidate])
      return candidate
    } catch { /* keep looking */ }
  }
  throw new Error(`cannot find ${name} on PATH`)
}

/**
 * Put a counting `git` first on PATH. `beginStage`/`endStage` slice the call log so every stage
 * reports only its own work. `indexBytes` sums the index size observed when an index-rewriting
 * command started: each of read-tree/add/update-index rewrites the whole index, so this is the
 * full-index-per-rewrite estimate, not a byte counter inside Git.
 */
export function installGitProbe(tempRoot, { indexBytes = process.env.SCRY_BENCH_INDEX_BYTES === '1' } = {}) {
  const bin = join(tempRoot, 'git-bin')
  const log = join(tempRoot, 'git-calls.log')
  mkdirSync(bin, { recursive: true })
  const realGit = findExecutable('git')
  const wrapper = [
    '#!/bin/sh',
    'if [ -n "$SCRY_BENCH_GIT_LOG" ]; then',
    '  sz=',
    '  if [ -n "$GIT_INDEX_FILE" ] && [ -f "$GIT_INDEX_FILE" ]; then sz=$(wc -c < "$GIT_INDEX_FILE"); fi',
    '  printf \'%s\\t%s\\t%s\\n\' "$SCRY_BENCH_STAGE" "$sz" "$*" >> "$SCRY_BENCH_GIT_LOG"',
    'fi',
    'exec "$SCRY_BENCH_REAL_GIT" "$@"',
    ''
  ].join('\n')
  writeFileSync(join(bin, 'git'), wrapper)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.SCRY_BENCH_GIT_LOG = log
  process.env.SCRY_BENCH_REAL_GIT = realGit
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  let lines = 0
  return {
    realGit,
    indexBytesEnabled: indexBytes,
    beginStage(stage) { process.env.SCRY_BENCH_STAGE = stage },
    endStage() {
      process.env.SCRY_BENCH_STAGE = ''
      let text = ''
      try { text = readFileSync(log, 'utf8') } catch { text = '' }
      if (text) writeFileSync(log, '')
      const records = text.split('\n').filter(Boolean)
      lines += records.length
      const byCommand = {}
      let indexBytes = 0
      for (const record of records) {
        const [stage, size, args] = record.split('\t')
        if (stage !== undefined && args === undefined) continue
        const command = classify(args ?? '')
        byCommand[command] = (byCommand[command] ?? 0) + 1
        if (WRITES_INDEX.has(command)) indexBytes += Number(size || 0)
      }
      return { total: records.length, byCommand, indexBytes: indexBytes || 0, cumulative: lines }
    },
    stop() {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter((entry) => entry !== bin).join(':')
      delete process.env.SCRY_BENCH_GIT_LOG
      delete process.env.SCRY_BENCH_REAL_GIT
      delete process.env.SCRY_BENCH_STAGE
    }
  }
}

const WRITES_INDEX = new Set(['read-tree', 'add', 'update-index', 'rm', 'write-tree', 'reset', 'checkout', 'commit', 'merge', 'revert', 'apply', 'stash'])

const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

function classify(args) {
  const tokens = args.split(' ')
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) { index++; continue }
    if (token.startsWith('-')) continue
    return token
  }
  return 'unknown'
}

export async function workspaceRoot(tempRoot, label) {
  const root = await realpath(await mkdtemp(join(tempRoot, `${label}-`)))
  return root
}

export async function writeRecorderConfig(root, { workspaceId, mode = 'workspace-only', maxDepth = 2, diff = true }) {
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId,
    dataDir: '.scry',
    repositories: { mode, ...(mode === 'discover-nested-git' ? { maxDepth } : {}) },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff, hooks: true }
  }))
}

/** Create `count` tracked files under an already `git init`-ed directory. */
export async function writeTrackedFiles(cwd, count, prefix = 'src/f') {
  const batch = 200
  for (let start = 0; start < count; start += batch) {
    const pending = []
    for (let index = start; index < Math.min(count, start + batch); index++) {
      const path = join(cwd, `${prefix}${index}.ts`)
      pending.push(mkdir(join(path, '..'), { recursive: true }).then(() => writeFile(path, `export const v${index} = ${index}\n`)))
    }
    await Promise.all(pending)
  }
}

export async function newRepo(cwd, { files = 1, prefix = 'src/f' } = {}) {
  await mkdir(cwd, { recursive: true })
  await git(['init', '-q', '--initial-branch=main'], cwd)
  if (files > 0) await writeTrackedFiles(cwd, files, prefix)
  await commitAll(cwd)
  return cwd
}

export async function resetRepo(cwd) {
  await git(['reset', '-q', '--hard', 'HEAD'], cwd)
  await git(['clean', '-qfdx'], cwd)
}

export async function lineCount(directory, pattern) {
  try {
    const entries = await readdir(directory)
    return entries.filter((name) => pattern.test(name)).length
  } catch { return 0 }
}

export async function recordFiles(dataRoot) {
  return lineCount(join(dataRoot, 'records'), /\.json$/)
}

export async function waitForRecord(dataRoot, previousCount, timeoutMs = 5_000) {
  const started = process.hrtime.bigint()
  for (;;) {
    if (await recordFiles(dataRoot) > previousCount) return Number(process.hrtime.bigint() - started) / 1e6
    if (Number(process.hrtime.bigint() - started) / 1e6 > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Peak RSS sampler for the whole run: the benchmark and the recorder share one process. */
export function startRssSampler({ intervalMs = 10 } = {}) {
  const state = { peak: process.memoryUsage().rss, current: process.memoryUsage().rss }
  const timer = setInterval(() => {
    state.current = process.memoryUsage().rss
    state.peak = Math.max(state.peak, state.current)
  }, intervalMs)
  timer.unref?.()
  return {
    read() { return { peakBytes: state.peak, currentBytes: process.memoryUsage().rss } },
    /** Restart the peak window: a stage reports its own peak, not an earlier stage's. */
    reset() { state.current = process.memoryUsage().rss; state.peak = state.current },
    stop() { clearInterval(timer) }
  }
}

export function percentile(values, quantile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]
}

export function median(values) {
  return percentile(values, 0.5)
}

export function maybeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export async function statOf(path) {
  try { return await stat(path) } catch { return undefined }
}

/**
 * A Claude-shaped JSONL transcript. `turns` user lines split the byte budget, which is what tells a
 * per-turn window apart from a whole-file read: turn N's own bytes are about `bytes / turns`.
 */
export async function buildTranscript(path, bytes, { turns = 1, promptOf = (index) => `long session prompt ${index}` } = {}) {
  const chunk = 'x'.repeat(1024)
  const lines = []
  const share = Math.max(1, Math.floor(bytes / turns))
  let written = 0
  let index = 0
  for (let turn = 0; turn < turns; turn++) {
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: promptOf(turn) } })
    lines.push(user)
    written += user.length + 1
    const until = written + (turn === turns - 1 ? Math.max(0, bytes - written) : share)
    while (written < until) {
      const line = JSON.stringify({
        type: index % 3 === 0 ? 'assistant' : 'progress',
        message: { role: 'assistant', content: [{ type: 'text', text: `${index}:${chunk}` }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 3600)).toISOString()
      })
      lines.push(line)
      written += line.length + 1
      index++
    }
  }
  await writeFile(path, `${lines.join('\n')}\n`)
  return written
}

export { existsSync, readFile, utimes, writeFile, mkdir, rm, chmod }
