import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { markedSessions } from './attention'
import { resolveRecorderEnablement } from './config'
import { recorderInboxEntries } from './inbox'
import { recoverRecorder } from './recorder'
import { recorderHasOpenTurn, recorderPendingHealth, releaseStaleAttention } from './runtime-state'
import { safeKey } from './store'

const contention = vi.hoisted(() => ({ path: '', blocked: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      try {
        return await actual.mkdir(...args)
      } catch (error) {
        // Signal real native contention, not a process-local promise queue or a timing guess.
        if (args[0] === contention.path && (error as NodeJS.ErrnoException).code === 'EEXIST') contention.blocked?.()
        throw error
      }
    }
  }
})

it.each(['publish', 'crash-before', 'crash-after'] as const)(
  'serializes a separate queue writer and cleanup through %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'scry-attention-process-'))
    const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
    let child: ReturnType<typeof fork> | undefined
    let exited: Promise<number | null> | undefined
    let cleaning: Promise<void> | undefined
    try {
      await writeFile(join(root, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1, enabled: true, workspaceId: 'attention-process', dataDir: '.scry',
        repositories: { mode: 'workspace-only' }, capture: { diff: false }
      }))
      const enablement = await resolveRecorderEnablement(root, env)
      if (!enablement.enabled) throw new Error('fixture recorder is disabled')
      const sessionId = 'external-writer'
      const key = safeKey(sessionId)
      const sessionDir = join(enablement.dataRoot, 'runtime', 'claude', key)
      const lock = join(enablement.dataRoot, 'locks', 'attention', 'claude', `${key}.lock`)
      const core = join(root, 'queue.mjs'), script = join(root, 'child.mjs')
      await build({ entryPoints: ['src/core/turn-recorder/recorder-hook-queue.ts'], outfile: core,
        bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
      await writeFile(script, `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const resume = new Promise(resolve => process.once('message', resolve))
const pause = async () => { process.send({ paused: true }); await resume }
const originalOpen = fs.open, originalRm = fs.rm
fs.open = async (...args) => {
  if (${JSON.stringify(mode)} !== 'crash-after' && String(args[0]).startsWith(${JSON.stringify(join(sessionDir, 'inbox') + '/')})) await pause()
  return originalOpen(...args)
}
fs.rm = async (...args) => {
  // withDirectoryLock releases ownership only after the inbox file and its directory are synced.
  if (${JSON.stringify(mode)} === 'crash-after' && args[0] === ${JSON.stringify(lock)}) await pause()
  return originalRm(...args)
}
syncBuiltinESMExports()
const { queueHook } = await import(${JSON.stringify(pathToFileURL(core).href)})
await queueHook(${JSON.stringify(enablement)}, {
  provider: 'claude', event: 'UserPromptSubmit', queueOnly: true, workspace: ${JSON.stringify(root)},
  payload: { session_id: ${JSON.stringify(sessionId)}, prompt: 'external queued turn' }
}, ${JSON.stringify(sessionId)}, new Date().toISOString())
process.disconnect()
`)
      child = fork(script, [], { cwd: root, execArgv: ['--no-addons'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ...env } })
      const writer = child
      let stderr = ''
      writer.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_096) })
      exited = new Promise((resolve, reject) => { writer.once('exit', resolve); writer.once('error', reject) })
      await new Promise<void>((resolve, reject) => {
        writer.once('message', value => value && typeof value === 'object' && 'paused' in value
          ? resolve() : reject(new Error('writer did not pause at publication boundary')))
        writer.once('exit', code => reject(new Error(`writer exited before pause: ${code}; ${stderr}`)))
        writer.once('error', reject)
      })
      expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).pid).toBe(writer.pid)
      expect(await recorderInboxEntries(sessionDir)).toHaveLength(mode === 'crash-after' ? 1 : 0)
      contention.path = lock
      const blocked = new Promise<void>(resolve => { contention.blocked = resolve })
      cleaning = releaseStaleAttention(enablement.dataRoot, 'claude', sessionDir)
      await Promise.race([blocked, cleaning.then(() => { throw new Error('cleanup bypassed the live writer') })])
      if (mode === 'publish') writer.send('resume')
      else writer.kill('SIGKILL') // This test owns only this private fixture process.
      await cleaning
      expect(await exited).toBe(mode === 'publish' ? 0 : null)
      const hasPublished = mode !== 'crash-before'
      expect(await markedSessions(enablement.dataRoot)).toHaveLength(hasPublished ? 1 : 0)
      expect(await recorderInboxEntries(sessionDir)).toHaveLength(hasPublished ? 1 : 0)
      expect(await recorderHasOpenTurn(enablement.dataRoot)).toBe(hasPublished)
      expect((await recorderPendingHealth(enablement.dataRoot)).pendingCount).toBe(hasPublished ? 1 : 0)
      await expect(readFile(join(lock, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await recoverRecorder(root, env)
      expect(await recorderInboxEntries(sessionDir)).toHaveLength(0)
      const openPath = join(sessionDir, 'open.json')
      if (hasPublished) expect(JSON.parse(await readFile(openPath, 'utf8')).prompt).toBe('external queued turn')
      else await expect(readFile(openPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      contention.blocked = undefined
      contention.path = ''
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.allSettled([...(exited ? [exited] : []), ...(cleaning ? [cleaning] : [])])
      await rm(root, { recursive: true, force: true })
    }
  }
)
