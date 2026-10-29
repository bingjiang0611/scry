import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const original = resolve(process.argv[2]), output = resolve(process.argv[3])
const escape = relative(original, output)
if (!escape || escape.startsWith('..') || isAbsolute(escape)) throw new Error('negative control must be a new child of the prepared build')
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(original, 'manifest.json'), 'utf8'))
const code = await readFile(join(here, 'sqlite-worker.ts'), 'utf8')
const anchor = ' || digest(row.body) !== row.hash'
if (code.split(anchor).length !== 2) throw new Error('negative-control hash guard anchor changed')
await mkdir(output)
const workerPath = join(output, 'sqlite-worker.cjs')
await build({ stdin: { contents: code.replace(anchor, ''),
  resolveDir: here, sourcefile: 'negative-sqlite-worker.ts', loader: 'ts' }, outfile: workerPath,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const worker = await readFile(workerPath)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, workerPath,
  workerHash: createHash('sha256').update(worker).digest('hex'), negativeControl: 'metadata hash guard removed; never eligible for adoption' }, null, 2) + '\n')
console.log(JSON.stringify({ output, negativeControl: 'metadata-hash' }))
