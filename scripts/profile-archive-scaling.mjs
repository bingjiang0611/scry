import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Diagnostic, not a ratchet workload: first reader access plus five warm pages
// at each fixed size. First access is NOT a cold OS cache measurement.
const output = resolve(process.argv[2])
const source = resolve(import.meta.dirname, '..')
const root = fs.mkdtempSync(join(tmpdir(), 'scry-archive-scaling-'))
const report = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  scriptSha256: createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),
  workload: 'turns=40,400,4000;visible=40;text-bytes=256;warm-repeats=5;real-upsert',
  inputs: {},
  samples: [],
  sensitivity: []
}
let active
const originals = []
const record = (name, path) => {
  const sample = active
  if (!sample) return
  sample.calls[name] = (sample.calls[name] ?? 0) + 1
  if (name.includes('lstat') && /\/turn-[a-f0-9]{64}\.json$/.test(String(path))) {
    sample.canonicalLstats++
  }
  return sample
}
for (const [target, names, namespace] of [
  [fs, ['lstatSync', 'readdirSync', 'readFileSync', 'openSync'], 'fs'],
  [fsp, ['lstat', 'readdir', 'readFile', 'open'], 'fsp']
]) {
  for (const name of names) {
    const original = target[name]
    originals.push(() => { target[name] = original })
    target[name] = function (...args) {
      const sample = record(`${namespace}.${name}`, args[0])
      const result = Reflect.apply(original, this, args)
      if (!sample || !name.startsWith('readFile')) return result
      const count = value => {
        sample.readBytes += typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
        return value
      }
      return namespace === 'fsp' ? result.then(count) : count(result)
    }
  }
}
const parse = JSON.parse
JSON.parse = function (...args) {
  record('json.parse')
  return Reflect.apply(parse, this, args)
}
syncBuiltinESMExports()

try {
  const bundle = join(root, 'archive.mjs')
  const built = await build({
    absWorkingDir: source,
    entryPoints: ['src/main/transcript-archive.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    logLevel: 'silent'
  })
  for (const input of Object.keys(built.metafile.inputs).sort()) {
    report.inputs[input] = createHash('sha256').update(fs.readFileSync(join(source, input))).digest('hex')
  }
  const { upsertTraceArchiveTurn, readTraceArchivePageAsync } = await import(pathToFileURL(bundle).href)
  const save = () => {
    fs.mkdirSync(dirname(output), { recursive: true })
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  for (const turns of [40, 400, 4000]) {
    const directory = join(root, String(turns))
    const cwd = join(directory, 'workspace')
    fs.mkdirSync(cwd, { recursive: true })
    const args = { cwd, userDataDir: join(directory, 'user-data'), sessionId: 'archive-scaling', providerId: 'codex' }
    for (let index = 0; index < turns; index++) {
      const id = String(index).padStart(6, '0')
      assert.equal(upsertTraceArchiveTurn({ ...args, turn: {
        runId: `run-${id}`, userText: `request ${id}`, done: true, ts: index,
        items: [{ id: `event-${id}`, ts: new Date(index * 1000).toISOString(), runId: `run-${id}`, kind: 'model', stage: 'text', text: 'x'.repeat(256) }]
      } }), true)
    }
    const measure = async (phase, repeat, sensitivity = false) => {
      const sample = { turns, phase, repeat, calls: {}, canonicalLstats: 0, readBytes: 0, durationMs: 0 }
      active = sample
      const start = performance.now()
      let page
      try {
        page = await readTraceArchivePageAsync(args, { limit: 40 })
        if (sensitivity) {
          await fsp.lstat(cwd)
          JSON.parse('{}')
        }
      } finally {
        sample.durationMs = performance.now() - start
        active = undefined
      }
      assert.equal(page.totalTurns, turns)
      assert.equal(page.archive?.turns.length, 40)
      assert.equal(page.sourceComplete, true)
      assert.equal(page.offset, turns - 40)
      assert.deepEqual(page.archive.turns.map(turn => turn.runId), Array.from({ length: 40 }, (_, index) => `run-${String(turns - 40 + index).padStart(6, '0')}`))
      sample.readMode = page.readMode
      sample.turnFilesRead = page.turnFilesRead
      assert.ok(sample.canonicalLstats >= turns, 'the current freshness contract checks off-page source files')
      return sample
    }
    report.samples.push(await measure('first-access', 0))
    for (let repeat = 0; repeat < 5; repeat++) report.samples.push(await measure('warm', repeat))
    const base = report.samples.at(-1)
    const control = await measure('sensitivity', 0, true)
    assert.equal(control.calls['fsp.lstat'], base.calls['fsp.lstat'] + 1)
    assert.equal(control.calls['json.parse'], base.calls['json.parse'] + 1)
    assert.equal(control.canonicalLstats, base.canonicalLstats)
    report.sensitivity.push({ turns, extraLstat: 1, extraParse: 1, passed: true })
    save()
    console.log(JSON.stringify({ turns, samples: report.samples.filter(sample => sample.turns === turns), sensitivity: report.sensitivity.at(-1) }))
  }
} finally {
  active = undefined
  JSON.parse = parse
  for (const restore of originals) restore()
  syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
