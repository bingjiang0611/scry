#!/usr/bin/env node
// One A/B measurement session: base and candidate builds run interleaved (A B A B ...) on the same
// copy, each run behind a load gate, then perf-ab gives the verdict. This is the standard way to
// check one climb hypothesis; everything it does is local and offline (fake transport).
//
//   node ab-session.mjs --source <repo> --work <copy> --out <dir> \
//     --base-scry <cli> --cand-scry <cli> [--base-uploader <cli>] [--cand-uploader <cli>] \
//     [--base-label "base <commit>"] [--cand-label "cand <commit>"] \
//     [--phases recorder,hookwrap] [--pairs 2] [--rounds 7] [--workload-name <alias>] \
//     [--uploader-scry same|bundled] [--allow allowed.json] [--min-gain 10] [--ms-floor 5] [--protocol <file>]
//     [--load-limit <load1, default cores/2>] [--gate-wait-min 5] [--calibration <A/A AB json>] [--alpha 0.01]
//
// --uploader-scry same (default when an uploader is given): hookwrap installs hooks with the same
// scry CLI as the recorder under test, so a recorder change is measured on the wrapped path too.
// bundled: the uploader's own bundled recorder, as colleagues get it.
//
// Exit code is perf-ab's (0 no unallowed regression, 1 regression, 2 refused), or 4 when the load
// gate never opened, 3 on errors. Nothing here is a release or ratchet gate by itself.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const need = (name) => { const v = opt(name); if (!v) { console.error(`ab-session: --${name} is required`); process.exit(3) } return v }

const out = resolve(need('out'))
const source = resolve(need('source'))
const work = resolve(need('work'))
const phases = opt('phases', 'recorder,hookwrap')
const pairs = Number(opt('pairs', 2))
const rounds = opt('rounds', '7')
const sides = {
  base: { scry: resolve(need('base-scry')), uploader: opt('base-uploader') && resolve(opt('base-uploader')), label: opt('base-label', 'base') },
  cand: { scry: resolve(need('cand-scry')), uploader: opt('cand-uploader') && resolve(opt('cand-uploader')), label: opt('cand-label', 'cand') }
}
if (phases.split(',').some((p) => p !== 'recorder') && (!sides.base.uploader || !sides.cand.uploader)) {
  console.error('ab-session: uploader/hookwrap phases need --base-uploader and --cand-uploader (the same path is fine when only the recorder changes)')
  process.exit(3)
}
const uploaderScry = opt('uploader-scry', 'same')
const gateLimit = Number(opt('load-limit', cpus().length / 2))
const gateWaitMs = Number(opt('gate-wait-min', 5)) * 60_000

async function loadGate(tag) {
  for (let i = 0; i < 3; i++) {
    const l = loadavg()[0]
    if (l < gateLimit) return { load1: Math.round(l * 100) / 100, waitedChecks: i }
    console.log(`  ${tag}: load ${l.toFixed(2)} >= ${gateLimit}, waiting ${gateWaitMs / 60_000} minutes (${i + 1}/3)`)
    await sleep(gateWaitMs)
  }
  return undefined
}

mkdirSync(out, { recursive: true })
const log = []
const order = []
for (let i = 1; i <= pairs; i++) order.push(...(i % 2 ? ['base', 'cand'] : ['cand', 'base']).map((side) => ({ side, i })))
for (const { side, i } of order) {
  const s = sides[side]
  const dir = join(out, `${side}-${i}`)
  const gate = await loadGate(`${side} ${i}`)
  if (!gate) { console.error(`ab-session: load stayed >= ${gateLimit} for 3 checks before ${side} ${i}; stopped, nothing compared`); process.exit(4) }
  const args = [join(here, 'perf-bench.mjs'), '--source', source, '--work', work, '--scry', s.scry, '--phases', phases, '--rounds', rounds,
    '--label', s.label, '--out', dir]
  if (s.uploader) args.push('--uploader', s.uploader)
  if (s.uploader && uploaderScry === 'same') args.push('--uploader-scry', s.scry)
  if (opt('workload-name')) args.push('--workload-name', opt('workload-name'))
  if (opt('protocol')) args.push('--protocol', resolve(opt('protocol')))
  console.log(`run ${side} ${i} (${s.label}), load ${gate.load1}`)
  const started = Date.now()
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
  log.push({ side, i, label: s.label, exit: r.status, seconds: Math.round((Date.now() - started) / 1000), loadAtStart: gate.load1 })
  if (r.status !== 0) { console.error(`ab-session: perf-bench ${side} ${i} exited ${r.status}`); writeFileSync(join(out, 'session.json'), JSON.stringify({ log }, null, 2)); process.exit(3) }
}
writeFileSync(join(out, 'session.json'), JSON.stringify({ phases, pairs, rounds, uploaderScry, sides, log }, null, 2).split(process.env.HOME || '\u0000').join('~') + '\n')

const files = (side) => order.filter((o) => o.side === side).map(({ i }) => {
  const dir = join(out, `${side}-${i}`)
  const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith('baseline-') && n.endsWith('.json')) : undefined
  return f && join(dir, f)
}).filter(Boolean)
const abArgs = [join(here, 'perf-ab.mjs'), '--base', ...files('base'), '--cand', ...files('cand'), '--phases', phases, '--out', out,
  '--min-gain', opt('min-gain', '10'), '--ms-floor', opt('ms-floor', '5')]
if (opt('allow')) abArgs.push('--allow', resolve(opt('allow')))
if (opt('calibration')) abArgs.push('--calibration', resolve(opt('calibration')))
if (opt('alpha')) abArgs.push('--alpha', opt('alpha'))
const ab = spawnSync(process.execPath, abArgs, { stdio: 'inherit' })
process.exit(ab.status ?? 3)
