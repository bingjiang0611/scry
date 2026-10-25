// Real, temporary content stores; counts payload hashing separately from durable I/O.
// Run under .agents/skills/scry-performance-climb/scripts/timing-run.mjs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-trace-content-profile-'))
const nativeHash = crypto.createHash
let observation
try {
  await build({ stdin: { contents: `
    export { persistTraceToolEvents, readAppTraceContentPage } from './src/main/trace-tool-content'
    export { readRecorderContent } from './src/core/turn-recorder/content-store'
  `, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: join(temp, 'content.cjs') })
  crypto.createHash = function (...args) {
    const hash = nativeHash.apply(this, args)
    const update = hash.update, digest = hash.digest
    let payload = false
    hash.update = function (data, ...rest) {
      payload = observation != null && Buffer.isBuffer(data) && data.length === observation.bytes
      const started = performance.now()
      const result = update.call(this, data, ...rest)
      if (payload) { observation.payloadHashes++; observation.hashMs += performance.now() - started }
      return result
    }
    hash.digest = function (...values) {
      const started = performance.now()
      const result = digest.apply(this, values)
      if (payload && observation) observation.hashMs += performance.now() - started
      return result
    }
    return hash
  }
  const { persistTraceToolEvents, readAppTraceContentPage, readRecorderContent } = createRequire(import.meta.url)(join(temp, 'content.cjs'))
  const samples = []
  for (const bytes of [16 * 1024, 1024 * 1024]) {
    const output = 'x'.repeat(bytes)
    const event = { id: 'result', runId: 'run', ts: '2026-10-25T00:00:00.000Z', kind: 'tool', stage: 'tool_result', toolUseId: 'call', output, text: output }
    for (const copies of [1, 2]) {
      for (let repeat = 0; repeat < 5; repeat++) {
        const userData = join(temp, `${bytes}-${copies}-${repeat}`)
        const recorder = copies === 2 ? join(userData, 'recorder') : undefined
        for (const existing of [false, true]) {
          observation = { bytes, copies, existing, payloadHashes: 0, hashMs: 0 }
          const beforeCpu = process.cpuUsage(), started = performance.now()
          const [persisted] = await persistTraceToolEvents(userData, '/fixture/project', [event], recorder)
          const elapsedMs = performance.now() - started, cpu = process.cpuUsage(beforeCpu)
          const sample = { ...observation, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000 }
          observation = undefined
          const ref = persisted.outputContent?.contentRef
          assert.equal(ref?.bytes, bytes)
          assert.ok(sample.payloadHashes > 0, 'payload hash counter unavailable')
          const pages = []
          let offset = 0
          while (offset < ref.bytes) {
            const page = await readAppTraceContentPage(userData, '/fixture/project', { source: 'app-trace', ref, offset })
            pages.push(Buffer.from(page.dataBase64, 'base64'))
            offset = page.nextOffset
          }
          assert.equal(Buffer.concat(pages).toString('utf8'), output)
          // Independent retained copies are required; never trade durability for a lower count.
          if (recorder) assert.equal(await readRecorderContent(recorder, ref), output)
          samples.push(sample)
        }
      }
    }
  }
  console.log(JSON.stringify({ scope: 'real content persistence, synthetic string payload, single/dual root, fresh/existing blobs', samples }))
} finally {
  observation = undefined
  crypto.createHash = nativeHash
  await rm(temp, { recursive: true, force: true })
}
