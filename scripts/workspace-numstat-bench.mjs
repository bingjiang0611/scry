// Informational, fixed workload for batch C. Run through timing-run.mjs.
// The instrumentation is identical for both implementations; no production hooks.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const original = childProcess.execFile
const execute = original[promisify.custom]
let active
async function observe(args, options, operation) {
  if (!active) return operation()
  const sample = active
  sample.spawns++
  sample.commands.push(args)
  try { return await operation() } finally {
    const objectDir = options?.env?.GIT_OBJECT_DIRECTORY
    if (objectDir) {
      for (const prefix of await readdir(objectDir)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue
        for (const suffix of await readdir(join(objectDir, prefix))) {
          const key = `${objectDir}/${prefix}/${suffix}`
          if (sample.objects.has(key)) continue
          const object = inflateSync(await readFile(key))
          sample.objects.set(key, object.subarray(0, object.indexOf(32)).toString())
        }
      }
    }
  }
}
// Core uses promisify(execFile). Keep its actual child lifecycle and error behavior.
const wrapped = (...args) => original(...args)
wrapped[promisify.custom] = (file, args, options) => file === 'git'
  ? observe(args, options, () => execute(file, args, options))
  : execute(file, args, options)
childProcess.execFile = wrapped
syncBuiltinESMExports()

const core = await import(pathToFileURL(join(process.cwd(), 'packages/turn-recorder-cli/dist/core/turn-recorder/git.js')))
const implementation = process.env.BENCH_IMPL ?? 'gitNumstat'
assert.equal(typeof core[implementation], 'function', `missing implementation: ${implementation}`)
const rounds = Number(process.env.BENCH_ROUNDS ?? 6)
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: '' }
Object.assign(process.env, env)
const git = (cwd, args) => childProcess.execFileSync('git', args, { cwd, env })
const results = []
for (const size of [8, 5000]) {
  const root = await mkdtemp(join(tmpdir(), 'scry-workspace-bench-'))
  try {
    git(root, ['init', '-q'])
    for (let index = 0; index < size; index++) await writeFile(join(root, `file-${index}.txt`), `baseline ${index}\n`)
    await writeFile(join(root, '.gitignore'), '.scry/\n')
    git(root, ['add', '.'])
    git(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=bench', '-c', 'user.email=bench@scry.local', 'commit', '-qm', 'baseline'])
    await writeFile(join(root, 'file-0.txt'), 'changed\nsecond\n')
    await rm(join(root, 'file-1.txt'))
    for (const name of ['new.txt', '中文.txt', 'empty.txt']) await writeFile(join(root, name), name === 'empty.txt' ? '' : 'new\n')
    await mkdir(join(root, '.scry'))
    await writeFile(join(root, '.scry/noise.txt'), 'excluded\n')
    const indexBefore = await readFile(join(root, '.git/index'))
    const samples = []
    for (let round = 0; round <= rounds; round++) {
      active = { spawns: 0, commands: [], objects: new Map() }
      const start = performance.now()
      const result = await core[implementation](root)
      const elapsedMs = performance.now() - start
      const counters = active
      active = undefined
      assert.equal(result.status, 'captured', JSON.stringify(result))
      assert.equal(result.files.length, 5)
      assert.deepEqual(await readFile(join(root, '.git/index')), indexBefore)
      if (round) samples.push({ elapsedMs, spawns: counters.spawns, objectsWritten: counters.objects.size,
        blobsWritten: [...counters.objects.values()].filter(type => type === 'blob').length,
        treesWritten: [...counters.objects.values()].filter(type => type === 'tree').length })
    }
    const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b)
    results.push({ trackedFiles: size + 1, dirtyPaths: 5, untrackedFiles: 3, excluded: 'ignored .scry/noise.txt', samples,
      p50Ms: sorted[Math.floor(sorted.length / 2)], hashOperations: { availability: 'unavailable', reason: 'Git does not expose all content hashes; unique written blob/tree objects counted separately' } })
  } finally { active = undefined; await rm(root, { recursive: true, force: true }) }
}
console.log(JSON.stringify({ implementation, rounds, results }, null, 2))
