import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { resolve, dirname, basename, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const original = await realpath(process.argv[2])
const requested = resolve(process.argv[3]), output = join(await realpath(dirname(requested)), basename(requested))
const mode = process.argv[4] ?? 'metadata-hash'
const escape = relative(original, output)
if (!escape || escape.startsWith('..') || isAbsolute(escape)) throw new Error('negative control must be a new child of the prepared build')
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(original, 'manifest.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function replace(code, anchor, replacement) {
  if (code.split(anchor).length !== 2) throw new Error('negative-control anchor changed: ' + anchor)
  return code.replace(anchor, replacement)
}
let worker = await readFile(join(here, 'sqlite-worker.ts'), 'utf8')
let generated = await readFile(manifest.generatedPath, 'utf8')
if (mode === 'metadata-hash') worker = replace(worker, ' || digest(row.body) !== row.hash', '')
else if (mode === 'early-ack') {
  worker = replace(worker, '          port.postMessage({ held: true })',
    '          port.postMessage({ id: request.id, ok: true })\n          port.postMessage({ held: true })')
  worker = replace(worker, '        unknown = false\n        break', "        unknown = false\n        if (current === 'hold_commit') return // Already sent the intentionally premature response.\n        break")
} else if (mode === 'result-hash') {
  generated = replace(generated, "    if (createHash('sha256').update(text).digest('hex') !== reference.hash) throw new Error(workflowFrameCopy.digest)\n", '')
} else if (mode === 'frame-cas') {
  generated = replace(generated, 'const next = nextWorkflowFrame(await this.loadFrame(input.workflowId, input.frameId), input, expectedRevision)',
    'const next = { ...input, revision: expectedRevision + 1 }')
} else if (mode === 'epoch') {
  generated = replace(generated, '      workflowEpochMatches(await this.load(id), record)\n', '')
} else if (mode === 'value-cache') {
  generated = replace(generated, '    const saved = await this.withFrameLock(frame, expectedRevision, async (name, next) => {',
    '    return this.withFrameLock(frame, expectedRevision, async (name, next) => {')
  generated = replace(generated, '    })\n    this.rememberOutput(value.name)\n    return saved\n  }',
    '      this.rememberOutput(value.name)\n    })\n  }')
} else throw new Error('unknown negative control')
await mkdir(output)
const workerPath = join(output, 'sqlite-worker.cjs'), generatedPath = join(output, 'workflow-store.ts')
await build({ stdin: { contents: worker, resolveDir: here, sourcefile: 'negative-sqlite-worker.ts', loader: 'ts' },
  outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
await writeFile(generatedPath, generated)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, workerPath, generatedPath,
  generatedHash: digest(generated), generatedBytes: Buffer.byteLength(generated), workerHash: digest(await readFile(workerPath)),
  negativeControl: mode + '; deliberately broken; never eligible for adoption' }, null, 2) + '\n')
console.log(JSON.stringify({ output, negativeControl: mode }))
