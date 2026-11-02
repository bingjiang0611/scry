import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { withDirectoryLock } from './io'

it('keeps native cross-process ownership and acquires a new owner token for every locally queued action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-process-'))
  let child: ReturnType<typeof fork> | undefined
  let exited: Promise<number | null> | undefined
  try {
    const core = join(root, 'io.mjs'), script = join(root, 'child.mjs'), lock = join(root, 'queue.lock')
    await build({ entryPoints: ['src/core/turn-recorder/io.ts'], outfile: core, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    await writeFile(script, `
import { withDirectoryLock } from ${JSON.stringify(pathToFileURL(core).href)}
const release = new Promise(resolve => process.once('message', resolve))
await withDirectoryLock(process.argv[2], async () => {
  process.send({ held: true })
  await release
})
process.disconnect()
`)
    child = fork(script, [lock], { cwd: root, execArgv: ['--no-addons'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const processChild = child
    exited = new Promise((resolve, reject) => { processChild.once('exit', resolve); processChild.once('error', reject) })
    await new Promise<void>((resolve, reject) => {
      processChild.once('message', value => value && typeof value === 'object' && 'held' in value ? resolve() : reject(new Error('missing native owner')))
      processChild.once('exit', code => reject(new Error(`child exited before lock acquisition: ${code}`)))
    })
    const external = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
    expect(external.pid).toBe(child.pid)
    const tokens: string[] = []
    const actions = [0, 1].map(() => withDirectoryLock(lock, async () => {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
      expect(owner.pid).toBe(process.pid)
      expect(owner.token).not.toBe(external.token)
      tokens.push(owner.token)
    }))
    child.send('release')
    await Promise.all(actions)
    expect(new Set(tokens).size).toBe(2)
    expect(await exited).toBe(0)
  } finally {
    // Only this registered, private fixture process may be terminated on failure.
    if (child && child.exitCode === null) child.kill('SIGKILL')
    if (exited) await exited
    await rm(root, { recursive: true, force: true })
  }
})
