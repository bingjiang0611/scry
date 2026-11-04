import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './bench-util.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'baseline'
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const ROUNDS = Number(opt('rounds', 7))
// Real protocol names can live outside the checkout (--protocol or SCRY_PERF_PROTOCOL), so they can
// never be committed by accident. Default: protocol.json next to this script (public aliases).
const PROTOCOL_PATH = resolve(opt('protocol', process.env.SCRY_PERF_PROTOCOL || join(here, 'protocol.json')))
const outDir = resolve(opt('out', join(process.cwd(), 'perf-baseline')))
mkdirSync(outDir, { recursive: true })

// ---------- lock: one timing run at a time ----------
const lockPath = join(tmpdir(), 'scry-perf-bench.lock')
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  if (alive) { console.error(`another perf-bench run holds ${lockPath} (pid ${pid})`); process.exit(2) }
}
writeFileSync(lockPath, String(process.pid))
process.on('exit', () => { try { rmSync(lockPath) } catch {} })

export { here, argv, sub, opt, sleep, now, ROUNDS, PROTOCOL_PATH, outDir, lockPath }
