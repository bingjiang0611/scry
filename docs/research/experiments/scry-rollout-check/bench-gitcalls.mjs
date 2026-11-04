import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sub } from './bench-args.mjs'
import { hook, run, settledCount, tryRun, turn, unavailable } from './bench-util.mjs'
import { now } from './bench-args.mjs'

// ---------- L1: git subprocesses per hook event ----------
// A `git` shim placed first on PATH logs each call, then execs the real git. It runs in a separate,
// untimed pass (the shim itself costs a fork), with the recorder daemon restarted under the shim so
// the daemon's git calls are counted too. Counts are exact and machine independent: a lower count
// is L1 evidence, a higher one is a regression no matter what the milliseconds say.
let gitShim
function gitShimDir() {
  if (gitShim) return gitShim
  const real = tryRun('/bin/sh', ['-c', 'command -v git'])
  if (!real) return undefined
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-perf-gitshim-')))
  // Logs the git subcommand (first argument that is not a global option) for the breakdown.
  const shim = [
    '#!/bin/sh',
    'if [ -n "$SCRY_PERF_GIT_LOG" ]; then',
    '  sub=; skip=',
    '  for a in "$@"; do',
    '    if [ -n "$skip" ]; then skip=; continue; fi',
    '    case "$a" in -C|-c|--git-dir|--work-tree|--namespace|--exec-path) skip=1 ;; -*) ;; *) sub=$a; break ;; esac',
    '  done',
    `  printf '%s\\n' "\${sub:-?}" >> "$SCRY_PERF_GIT_LOG"`,
    'fi',
    `exec ${JSON.stringify(real)} "$@"`, '']
  writeFileSync(join(dir, 'git'), shim.join('\n'), { mode: 0o755 })
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  gitShim = dir
  return dir
}
async function countGitCalls(work, provider, tools, env, dirty, exactEnv, stop) {
  const dir = gitShimDir()
  if (!dir) return unavailable('git not found on PATH')
  const log = join(dir, `calls-${randomBytes(4).toString('hex')}.log`)
  const basePath = (exactEnv ?? process.env).PATH ?? ''
  // No background upload workers during the count: only work done on the hook path (including the
  // launchers the hook waits for) is counted, so the numbers do not depend on worker timing.
  const counted = { ...env, PATH: `${dir}:${basePath}`, SCRY_PERF_GIT_LOG: log, SCRY_UPLOADER_NO_SPAWN: '1' }
  stop()   // the next hook starts a daemon that inherits the shim
  await turn(work, provider, 1, counted, undefined, exactEnv)   // warm-up under the shim, not counted
  await settledCount(log)
  const session = `perf-count-${randomBytes(4).toString('hex')}`
  let clock = Date.now()
  const ts = () => new Date(++clock).toISOString()
  const base = { session_id: session, cwd: work }
  const delta = async (fn) => { const before = await settledCount(log); fn(); return (await settledCount(log)) - before }
  const out = { turnStart: 0, toolEvents: 0, stop: 0 }
  out.turnStart = await delta(() => hook(work, provider, 'UserPromptSubmit', { ...base, prompt: `[perf-bench] ${session}`, timestamp: ts() }, counted, exactEnv))
  if (dirty) dirty.apply()
  for (let i = 0; i < tools; i++) {
    const id = `call-${i}`
    out.toolEvents += await delta(() => hook(work, provider, 'PreToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_input: { command: `echo ${i}` }, timestamp: ts() }, counted, exactEnv))
    out.toolEvents += await delta(() => hook(work, provider, 'PostToolUse', { ...base, tool_name: 'Bash', tool_use_id: id, tool_response: `out ${i}\n`.repeat(20), timestamp: ts() }, counted, exactEnv))
  }
  out.stop = await delta(() => hook(work, provider, 'Stop', { ...base, assistant_response: 'done', timestamp: ts() }, counted, exactEnv))
  if (dirty) dirty.restore()
  stop()   // later timed turns must not run under the shim
  const subcommands = {}
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) subcommands[l] = (subcommands[l] ?? 0) + 1
  return { status: 'measured', unit: 'count', ...out, total: out.turnStart + out.toolEvents + out.stop, note: 'one counted turn after a counted warm-up; includes git run by the daemon and by uploader launchers', subcommandsInclWarmup: subcommands }
}

const VOLATILE_KEY = /(At|Ms|Time|time|timestamp|duration|recordId|sessionId|session_id|sequence|generation|turnIndex|recorderVersion|pid)$/
function normalise(value, root) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, root))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) if (!VOLATILE_KEY.test(k)) out[k] = normalise(value[k], root)
    return out
  }
  return typeof value === 'string' ? value.split(root).join('<root>') : value
}
async function evidenceDigest(work, provider, dirty, env = {}) {
  const dir = join(work, '.scry', 'records')
  const before = new Set(existsSync(dir) ? readdirSync(dir) : [])
  await turn(work, provider, 2, env, dirty)
  const added = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.json') && !before.has(n)).sort()
  if (added.length !== 1) return unavailable(`expected 1 new record, found ${added.length}`)
  const record = JSON.parse(readFileSync(join(dir, added[0]), 'utf8'))
  const sections = normalise({ status: record.status, diff: record.diff, files: record.files, tools: record.tools?.status }, work)
  if (Array.isArray(sections.diff?.value)) for (const snap of sections.diff.value) if (Array.isArray(snap.files)) snap.files.sort((a, b) => String(a.path).localeCompare(String(b.path)))
  const text = JSON.stringify(sections)
  return { status: 'measured', digest: createHash('sha256').update(text).digest('hex'),
    diffFiles: Array.isArray(record.diff?.value) ? record.diff.value.reduce((n, s) => n + (s.files?.length ?? 0), 0) : null,
    diffStatus: record.diff?.status, bytes: text.length }
}

export { gitShim, gitShimDir, countGitCalls, VOLATILE_KEY, normalise, evidenceDigest }
