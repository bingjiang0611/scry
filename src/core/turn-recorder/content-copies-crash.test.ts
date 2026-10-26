import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ToolContentRef } from '../../shared/tool-content'

type Publisher = {
  child: ReturnType<typeof fork>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  killRequested: boolean
  phase: string
}
const running = new Set<Publisher>()
let root: string
let script: string
const body = 'process interruption must not expose a partial authority '.repeat(128)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry content crash-'))
  const core = join(root, 'content-store.mjs')
  script = join(root, 'publisher.mjs')
  await build({ entryPoints: ['src/core/turn-recorder/content-store.ts'], outfile: core, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  await writeFile(script, `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
const [directory, stopAfter] = process.argv.slice(2)
const link = fs.link
let links = 0
process.on('message', () => {})
fs.link = async (...args) => {
  await link(...args)
  if (++links === Number(stopAfter)) {
    await new Promise((resolve, reject) => process.send({ pausedAfterLink: links }, error => error ? reject(error) : resolve()))
    await new Promise(() => {})
  }
}
syncBuiltinESMExports()
const { writeRecorderContentCopies } = await import(${JSON.stringify(pathToFileURL(core).href)})
const ref = await writeRecorderContentCopies([join(directory, 'app'), join(directory, 'workspace')], ${JSON.stringify(body)}, 'utf8')
await fs.writeFile(join(directory, 'returned.json'), JSON.stringify(ref))
process.disconnect()
`)
})

async function stopPublisher(publisher: Publisher): Promise<void> {
  const { child } = publisher
  if (!publisher.killRequested && child.exitCode === null && child.signalCode === null) {
    publisher.killRequested = true
    child.kill('SIGKILL')
  }
  try { await publisher.exited } finally { running.delete(publisher) }
}

afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && running.size) {
    console.error('Publisher state at failure', [...running].map(({ child, phase, killRequested }) => ({ pid: child.pid, phase, killRequested, exitCode: child.exitCode, signalCode: child.signalCode })))
  }
  // Vitest's timeout does not cancel the test promise. Reap only our registered children.
  await Promise.all([...running].map(stopPublisher))
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function publisher(directory: string, stopAfter: number) {
  const child = fork(script, [directory, String(stopAfter)], { execArgv: ['--no-addons'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-4000) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const publisher: Publisher = { child, exited, killRequested: false, phase: stopAfter ? 'awaiting-link-' + stopAfter : 'recovering' }
  running.add(publisher)
  try {
    if (stopAfter) {
      const paused = new Promise<unknown>(resolve => child.once('message', resolve))
      expect(await Promise.race([paused, exited.then(result => { throw new Error(`Publisher exited before interruption: ${JSON.stringify(result)} ${stderr}`) })])).toEqual({ pausedAfterLink: stopAfter })
      publisher.phase = 'interrupted-after-link-' + stopAfter
      publisher.killRequested = true
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
    } else {
      expect(await exited, stderr).toEqual({ code: 0, signal: null })
    }
  } finally {
    await stopPublisher(publisher)
  }
}

describe('content copy process interruption (not a power-loss simulation)', () => {
  it.each([1, 2])('recovers after link %s but before its directory barrier without a premature return', async (link) => {
    const directory = join(root, 'case-' + link)
    await publisher(directory, link)
    await expect(readFile(join(directory, 'returned.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await publisher(directory, 0)
    const ref: ToolContentRef = JSON.parse(await readFile(join(directory, 'returned.json'), 'utf8'))
    expect(ref.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(ref.bytes).toBe(Buffer.byteLength(body))
    for (const authority of ['app', 'workspace']) {
      expect(await readFile(join(directory, authority, 'content', 'sha256', ref.sha256.slice(0, 2), ref.sha256 + '.bin'), 'utf8')).toBe(body)
    }
  })
})
