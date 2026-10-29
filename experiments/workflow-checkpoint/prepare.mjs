import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url)), repository = resolve(here, '../..')
const output = await realpath(process.argv[2])
if (!output.startsWith('/private/tmp/scry-checkpoint-') && !output.startsWith('/tmp/scry-checkpoint-')) throw new Error('prepare requires an existing dedicated temporary directory')
const sourcePath = join(repository, 'src/main/workflow-store.ts')
const source = await readFile(sourcePath, 'utf8')
const digest = value => createHash('sha256').update(value).digest('hex')
let generated = source
function replace(oldText, newText) {
  if (generated.split(oldText).length !== 2) throw new Error('nonunique generation anchor: ' + oldText)
  generated = generated.replace(oldText, newText)
}
replace("import { withDirectoryLock } from '../core/turn-recorder/io'", `import { metadataTransaction as withDirectoryLock, metadataRead, metadataPut, metadataName, noteDeferredArtifact, prototypeDirectory as opendir } from '${here}/runtime'`)
replace('import { open, opendir }', 'import { open }')
replace('  private async readText(name: string): Promise<string | undefined> {', '  private async readText(name: string): Promise<string | undefined> {\n    if (metadataName(name)) return metadataRead(this.directory, name)')
replace("    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('工作流记录超过 8 MiB 写入上限')", "    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('工作流记录超过 8 MiB 写入上限')\n    if (metadataName(name)) { await options?.beforePublish; return metadataPut(this.directory, name, text) }")
replace('publishWorkflowText(this.directory, name, text, options)', 'publishWorkflowText(this.directory, name, text, options).then(() => { if (options?.deferDirectorySync) noteDeferredArtifact(this.directory) })')
// metadataPut only stages SQL; the value cache must wait for the surrounding
// transaction acknowledgement, including a COMMIT that can genuinely reject.
replace('    return this.withFrameLock(frame, expectedRevision, async (name, next) => {', '    const saved = await this.withFrameLock(frame, expectedRevision, async (name, next) => {')
replace('      this.rememberOutput(value.name)\n    })\n  }', '    })\n    this.rememberOutput(value.name)\n    return saved\n  }')
// Keep all validators, result identity, fact boundaries and public Store methods.
// Resolver adapters keep relative imports bound to the original source directory.
await mkdir(join(output, 'build'))
const generatedPath = join(output, 'build/workflow-store.ts'), workerPath = join(output, 'build/sqlite-worker.cjs')
await writeFile(generatedPath, generated)
await build({ entryPoints: [join(here, 'sqlite-worker.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
await writeFile(join(output, 'build/manifest.json'), JSON.stringify({ sourcePath, sourceHash: digest(source), generatedPath, generatedHash: digest(generated), generatedBytes: Buffer.byteLength(generated), workerPath, workerHash: digest(await readFile(workerPath)), edits: ['metadata transaction/read/write', 'directory enumeration', 'deferred artifact barrier tracking', 'remember value after transaction acknowledgement'], productionEdited: false }, null, 2) + '\n')
console.log(JSON.stringify({ output, generatedPath, generatedBytes: Buffer.byteLength(generated), workerPath }))
