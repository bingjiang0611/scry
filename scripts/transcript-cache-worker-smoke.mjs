import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

// Actual production client source + actual built Worker. Offline temporary
// source only; no Provider, Electron, database or recorder writes. The subclass
// observes native Worker creation/exit, never substitutes its transport/parser.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const workerPath = join(root, 'out/main/transcript-parser-worker.js')
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const artifactSha256 = await hash(workerPath)
const clientSourceSha256 = await hash(join(root, 'src/main/transcript-parser.ts'))
const directory = await mkdtemp(join(tmpdir(), 'scry-transcript-worker-'))
const path = join(directory, 'session.jsonl')
const clientPath = join(directory, 'client.mjs')
const native = createRequire(import.meta.url)('node:worker_threads')
const OriginalWorker = native.Worker
const workers = []
let posts = 0, idleUnrefs = 0
native.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args)
    this.closed = new Promise(resolve => this.once('exit', resolve))
    workers.push(this)
  }
  postMessage(...args) { super.postMessage(...args); posts++; this.emit('fixture-posted') }
  unref() { idleUnrefs++; return super.unref() }
}
syncBuiltinESMExports()
const waitForPosts = target => new Promise(resolve => {
  const worker = workers.at(-1)
  const inspect = () => { if (posts >= target) { worker.off('fixture-posted', inspect); resolve() } }
  worker.on('fixture-posted', inspect); inspect()
})
const samples = []
let client
const context = { path, runId: 'worker-run', contextKey: 'claude:fixture:/temporary-workspace' }
const request = async () => {
  const started = performance.now()
  const result = await client.readCachedTranscript(context)
  samples.push({ cache: result.cache, bytes: result.bytes, parsedBytes: result.parsedBytes,
    elapsedMs: Number((performance.now() - started).toFixed(3)) })
  return result
}
const record = value => JSON.stringify({ timestamp: '2026-10-14T00:00:00Z', ...value })
const user = text => record({ type: 'user', promptId: text, message: { content: text } })
const assistant = (text, id) => record({ type: 'assistant', message: { id, model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } } })
const deadline = setTimeout(() => { console.error('Production transcript client smoke timed out'); client?.disposeTranscriptParser() }, 30_000)
try {
  await copyFile(workerPath, join(directory, 'transcript-parser-worker.js'))
  await cp(join(root, 'out/main/chunks'), join(directory, 'chunks'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  await build({ entryPoints: [join(root, 'src/main/transcript-parser.ts')], outfile: clientPath,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  client = await import(pathToFileURL(clientPath).href)
  const body = 'const value = "large worker fixture"\n'.repeat(4000)
  const records = []
  for (let index = 0; index < 40; index++) records.push(user(`turn-${index}`), assistant(body + `END ${index}`, `message-${index}`))
  const source = records.join('\n') + '\n'
  assert.ok(Buffer.byteLength(source) > 4 * 1024 * 1024)
  await writeFile(path, source)
  const cold = await request()
  assert.equal(cold.cache, 'cold')
  assert.equal(cold.turns.length, 40)
  for (let index = 0; index < 5; index++) {
    const hit = await request()
    assert.equal(hit.cache, 'hit'); assert.equal(hit.parsedBytes, 0)
    assert.deepEqual(hit.turns, cold.turns)
  }
  const suffix = user('added-turn') + '\n' + assistant('incremental answer', 'added-message')
  await appendFile(path, suffix)
  const incremental = await request()
  assert.equal(incremental.cache, 'incremental')
  assert.equal(incremental.parsedBytes, Buffer.byteLength(suffix))
  assert.equal(incremental.turns.length, 41)
  assert.deepEqual(incremental.turns.slice(0, 40), cold.turns)
  assert.equal(incremental.turns.at(-1).items.filter(item => item.stage === 'result').length, 1)
  await appendFile(path, '\n' + assistant('same usage again', 'added-message') + '\n')
  const committed = await request()
  assert.equal(committed.turns.at(-1).items.filter(item => item.stage === 'result').length, 1)
  // Neither head nor tail changes: a short fingerprint must not suffice.
  records[20] = user('rewritten-turn-10')
  await writeFile(path, records.join('\n') + '\n' + suffix + '\n')
  const rewritten = await request()
  assert.equal(rewritten.cache, 'cold'); assert.equal(rewritten.turns[10].userText, 'rewritten-turn-10')
  const namespace = await client.readCachedTranscript({ ...context, runId: 'other-run', contextKey: 'other-profile' })
  assert.equal(namespace.cache, 'cold')
  assert.ok(namespace.turns.every(turn => turn.items.every(item => item.runId === 'other-run')))

  const controller = new AbortController()
  const target = posts + 2
  const posted = waitForPosts(target)
  const cancelContext = { ...context, contextKey: 'cancellation' }
  const canceled = client.readCachedTranscript({ ...cancelContext, signal: controller.signal })
  const cancellation = assert.rejects(canceled, { name: 'AbortError' })
  const survivor = client.readCachedTranscript(cancelContext)
  await posted; controller.abort(); await cancellation
  assert.equal((await survivor).turns.length, 41)
  assert.equal(workers.length, 1, 'Client did not reuse one native Worker')
  assert.ok(idleUnrefs > 0, 'Idle Worker remained referenced')
  await rm(path); await assert.rejects(request(), /ENOENT/)
  await writeFile(path, source)

  // Start a real request, then dispose while it is registered/in flight.
  const disposingPosted = waitForPosts(posts + 1)
  const disposedRead = client.readCachedTranscript({ ...context, contextKey: 'dispose-in-flight' })
  const disposal = assert.rejects(disposedRead, /disposed/)
  await disposingPosted; client.disposeTranscriptParser(); await disposal
  const exitCodes = await Promise.all(workers.map(worker => worker.closed))
  const preflightRead = client.readCachedTranscript({ ...context, contextKey: 'dispose-before-stat-completes' })
  const preflightDisposal = assert.rejects(preflightRead, /disposed/)
  await client.disposeTranscriptParser()
  await preflightDisposal
  assert.equal(workers.length, 1, 'Disposal allowed a preflight read to resurrect the Worker')

  // A separate process deliberately does NOT dispose. It must exit naturally:
  // neither the native idle Worker nor either cache timer can pin Node's loop.
  const idleScript = join(directory, 'idle.mjs')
  await writeFile(idleScript, `import { readCachedTranscript } from './client.mjs';\nawait readCachedTranscript(${JSON.stringify(context)});\nconsole.log('idle-client-complete');\n`)
  const idle = await promisify(execFile)(process.execPath, [idleScript], { timeout: 10_000 })
  assert.equal(idle.stdout.trim(), 'idle-client-complete')
  assert.equal(await hash(workerPath), artifactSha256, 'Worker bundle changed during the smoke')
  assert.equal(await hash(join(root, 'src/main/transcript-parser.ts')), clientSourceSha256, 'Client source changed during the smoke')
  console.log(JSON.stringify({ artifactSha256, clientSourceSha256, node: process.version, platform: `${process.platform}/${process.arch}`,
    sourceBytes: Buffer.byteLength(source), samples,
    correctness: ['production client and native Worker', 'stable hit without JSON parsing', 'append-only parsing',
      'immutable prior turns', 'non-newline tail', 'usage deduplication across appends', 'interior rewrite detected',
      'deleted source rejected', 'profile/run namespace', 'one consumer canceled without canceling another',
      'one persistent Worker', 'in-flight disposal rejects and terminates', 'preflight disposal cannot resurrect Worker', 'idle process exits naturally'],
    cleanup: { workersTerminated: true, workerCount: workers.length, exitCodes, idleUnrefs, idleProcessExited: true } }, null, 2))
} finally {
  clearTimeout(deadline)
  client?.disposeTranscriptParser()
  await Promise.all(workers.map(worker => worker.closed))
  native.Worker = OriginalWorker; syncBuiltinESMExports()
  await rm(directory, { recursive: true, force: true })
}
