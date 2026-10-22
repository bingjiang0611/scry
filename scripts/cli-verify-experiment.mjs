#!/usr/bin/env node
// Synthetic canonical records: default L1 dispatch counters; --timing measures fresh CLI processes.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const output = process.argv[2]
assert(output, 'usage: node scripts/cli-verify-experiment.mjs <output.json> [--timing]')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'scry-verify-work-')))
const workspace = join(fixture, 'workspace')
const dataRoot = join(workspace, '.scry')
const recordsRoot = join(dataRoot, 'records')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const available = value => ({ status: 'available', quality: 'exact', source: ['fixture'], value })
const count = 64
const promptBytes = 64 * 1024
const recordBodies = new Set()
async function measureColdVerify(workspace, inputSha256, recordBytes) {
  const cli = join(root, 'packages/turn-recorder-cli/dist/cli/scry.js')
  const run = promisify(execFile)
  const samples = []
  for (let index = 0; index < 12; index++) {
    const started = performance.now()
    const { stdout } = await run(process.execPath, [cli, 'turns', 'verify', '--workspace', workspace], { cwd: workspace })
    const elapsed = performance.now() - started
    // The fixed baseline's complete report is the oracle, not a subset of its fields.
    assert.equal(sha256(JSON.stringify(JSON.parse(stdout))), 'de7068de91afb41641dcad3f87d25259c609d634f5559d3be51531833ef26dad')
    if (index >= 3) samples.push(elapsed)
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const modules = {}
  for (const name of ['cli/scry.js', 'core/turn-recorder/store.js', 'core/turn-recorder/turns-summary.js']) {
    modules[name] = sha256(await fs.promises.readFile(join(root, 'packages/turn-recorder-cli/dist', name)))
  }
  return { schema: 1, node: process.version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    scope: 'cold Node CLI process through exit and stdout collection; no instrumentation; warm filesystem, fresh process per run',
    workload: { records: count, promptBytes, recordBytes, toolsPerRecord: 1, identityObservedTurns: count / 2, pendingOpenTurns: 2 },
    inputSha256, outputSha256: 'de7068de91afb41641dcad3f87d25259c609d634f5559d3be51531833ef26dad',
    warmups: 3, samples, p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], modules }
}

try {
  await mkdir(recordsRoot, { recursive: true })
  await mkdir(join(fixture, 'home'))
  Object.assign(process.env, { HOME: join(fixture, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', SCRY_AUTO_UPDATE: '0' })
  delete process.env.SCRY_RECORDER_COMMIT_HOOK
  delete process.env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workspace])
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'fixture', dataDir: '.scry', capture: { diff: false } }))
  await writeFile(join(dataRoot, 'health.json'), JSON.stringify({ schemaVersion: 1, pendingCount: 2 }))
  const prompt = 'x'.repeat(promptBytes)
  for (let sequence = 1; sequence <= count; sequence++) {
    const observed = sequence % 2 === 0
    const record = {
      schemaVersion: 1, recordKind: 'agent_turn', sequence,
      recordId: String(sequence).padStart(32, '0'), recorderVersion: 'fixture',
      workspace: { id: 'fixture', root: '/fixture' },
      provider: observed ? { id: 'claude', model: 'fixture', modelStatus: 'observed', modelSource: 'provider_model_event' } : { id: 'claude' },
      sessionId: 'fixture-session', generation: sequence, turnIndex: sequence,
      startedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 1000 + 1000).toISOString(),
      durationMs: 1000, status: 'completed',
      user: available({ text: prompt, textHash: sha256(prompt) }), assistant: available({ text: 'fixture', textHash: sha256('fixture') }),
      tools: available([{ name: 'Read', category: 'tool', status: 'success', order: 0, completedOrder: 1, file: { path: `/fixture/file-${sequence}.ts`, operation: 'read' } }]),
      skills: available([]), mcps: available([]), hooks: available([]), files: available([]), diff: available([]),
      dangerousOperations: available([]), errors: available([]), usage: { status: 'unavailable', quality: 'unavailable', source: [] },
      turnRoleStatus: observed ? 'observed' : 'unobserved',
      ...(observed ? { turnRole: { role: 'main', source: 'integration' } } : {}),
      taskLinkStatus: observed ? 'bound' : 'unbound', linkedTaskId: observed ? `REQ-${sequence}` : null,
      ...(observed ? { linkedTaskGeneration: 'fixture' } : {})
    }
    const body = JSON.stringify(record) + '\n'
    recordBodies.add(body)
    await writeFile(join(recordsRoot, `${String(sequence).padStart(20, '0')}-${record.recordId}.json`), body)
  }
  const recordBytes = [...recordBodies].reduce((sum, body) => sum + Buffer.byteLength(body), 0)
  if (process.argv[3] === '--timing') {
    const report = await measureColdVerify(workspace, sha256([...recordBodies].join('')), recordBytes)
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  } else {
    const nativeReadFile = fs.promises.readFile
    const nativeParse = JSON.parse
    const nativeWrite = process.stdout.write
    const counts = { recordReads: 0, recordReadBytes: 0, recordParses: 0, toolEvidenceReads: 0 }
    let stdout = ''
    let code
    try {
      fs.promises.readFile = async function (path, ...args) {
        const value = await Reflect.apply(nativeReadFile, this, [path, ...args])
        if (typeof path === 'string' && path.startsWith(recordsRoot + '/')) {
          counts.recordReads++
          counts.recordReadBytes += Buffer.byteLength(value)
        }
        return value
      }
      JSON.parse = function (text, ...args) {
        const value = Reflect.apply(nativeParse, this, [text, ...args])
        if (recordBodies.has(text)) {
          counts.recordParses++
          let tools = value.tools
          Object.defineProperty(value, 'tools', {
            enumerable: true, configurable: true,
            get() { counts.toolEvidenceReads++; return tools },
            set(next) { tools = next }
          })
        }
        return value
      }
      process.stdout.write = function (chunk) { stdout += chunk; return true }
      syncBuiltinESMExports()
      const { runScryCli } = await import(pathToFileURL(join(root, 'packages/turn-recorder-cli/dist/cli/scry.js')).href)
      code = await runScryCli(['turns', 'verify', '--workspace', workspace])
    } finally {
      fs.promises.readFile = nativeReadFile
      JSON.parse = nativeParse
      process.stdout.write = nativeWrite
      syncBuiltinESMExports()
    }
    const result = JSON.parse(stdout)
    assert.equal(code, 0)
    assert.equal(result.ok, true)
    assert.equal(result.records, count)
    assert.equal(result.identity.model.coverage.knownTurns, count / 2)
    assert.equal(result.identity.model.coverage.complete, false)
    assert.equal(result.openTurnsPending, 2)
    assert.equal(result.advisories.length, 4)
    assert(counts.recordReads >= count, 'integrity verification must read every canonical record')
    assert.equal(counts.recordReads, counts.recordParses, 'a changed read/parse entry point must not silently evade observation')
    assert(counts.toolEvidenceReads >= count, 'production schema validation must still inspect each tool envelope')
    const report = { schema: 1, node: process.version,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      workload: { records: count, promptBytes, recordBytes, toolsPerRecord: 1, identityObservedTurns: count / 2, pendingOpenTurns: 2 },
      scope: 'canonical readFile calls and returned bytes, JSON parse calls and tool evidence property reads during real turns verify; not physical disk IO or wall time',
      inputSha256: sha256([...recordBodies].join('')), outputSha256: sha256(JSON.stringify(result)), exitCode: code,
      counts, result }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}
