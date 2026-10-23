import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkflowTemplateStore } from './workflow-template-store'

let root: string, entry: string
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scry-template-delete-process-')))
  entry = join(root, 'delete.mjs')
  await build({ entryPoints: ['scripts/fixtures/workflow-template-delete-process.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
async function stopOwned(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close') }
}

describe('deletion recovery after actual Node-controller exit, no Provider or network calls', () => {
  it.each(['after-intent', 'after-target', 'after-target-replaced'])('keeps %s non-replaying', async scene => {
    const user = join(root, scene + '-user'), project = join(root, scene + '-project'), locks = join(root, 'locks')
    await Promise.all([user, project].map(path => mkdir(path)))
    const authorize = (cwd: string) => { if (cwd !== project) throw new Error('unauthorized fixture project'); return cwd }
    const store = new WorkflowTemplateStore(user, authorize, locks)
    const draft = await store.saveDraft({ scope: { kind: 'project', workspace: project }, source: JSON.stringify({ schemaVersion: 1, name: 'Deletion process fixture', description: '', parameters: {}, roles: [],
      body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'value', value: { kind: 'literal', value: 'kept' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'value' } }] } }) })
    const published = await store.publish({ draftId: draft.draftId, draftRevision: 1, candidateHash: draft.candidateHash, commandId: 'publish' })
    if (published.state !== 'published') throw new Error('fixture publication failed')
    const request = { ref: published.ref, commandId: 'delete' }, requestPath = join(root, scene + '-request.json')
    await writeFile(requestPath, JSON.stringify(request))
    const child = spawn(process.execPath, [entry, scene === 'after-intent' ? scene : 'after-target', user, project, requestPath, locks], { env: { HOME: root, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk })
    try {
      const [code, signal] = await once(child, 'close')
      expect({ code, signal, stderr }).toEqual({ code: scene === 'after-intent' ? 77 : 78, signal: null, stderr: '' })
      const path = join(project, '.scry-workflows', draft.templateId + '.json')
      if (scene === 'after-target-replaced') await writeFile(path, draft.source + ' ')
      const before = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      const cold = new WorkflowTemplateStore(user, authorize, locks), result = await cold.delete(request)
      expect(result.state).toBe(scene === 'after-target' ? 'deleted' : 'unknown')
      if (before) {
        const after = await stat(path)
        expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs)
        expect(await readFile(path, 'utf8')).toBe(draft.source + (scene === 'after-target-replaced' ? ' ' : ''))
      } else {
        expect(result).toMatchObject({ state: 'deleted', verification: 'reconciled_absence' })
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect((await cold.revision(published.ref))?.source).toBe(draft.source)
      expect(await cold.delete(request)).toEqual(result)
    } finally { await stopOwned(child) }
  })
})
