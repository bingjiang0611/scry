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
  root = await realpath(await mkdtemp(join(tmpdir(), 'scry-template-process-')))
  entry = join(root, 'publication.mjs')
  await build({ entryPoints: ['scripts/fixtures/workflow-template-publication-process.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
async function stopOwned(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await once(child, 'close')
  }
}

describe('publication recovery in a different Node controller after actual process exit', () => {
  it.each(['after-intent', 'after-target'])('preserves %s evidence without replaying a publication', async mode => {
    const userData = join(root, mode + '-user'), project = join(root, mode + '-project')
    await Promise.all([userData, project].map(path => mkdir(path)))
    const authorize = (cwd: string) => { if (cwd !== project) throw new Error('unauthorized fixture project'); return cwd }
    const projectLocks = join(root, 'project-locks')
    const store = new WorkflowTemplateStore(userData, authorize, projectLocks)
    const draft = await store.saveDraft({ scope: { kind: 'project', workspace: project }, source: JSON.stringify({ schemaVersion: 1, name: 'Interrupted publication', description: '', parameters: {}, roles: [],
      body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'answer', value: { kind: 'literal', value: 'retained' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'answer' } }] } }) })
    expect(draft.validation.state).toBe('valid')
    const request = { draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: mode }
    const requestPath = join(root, mode + '-request.json'); await writeFile(requestPath, JSON.stringify(request))
    const child = spawn(process.execPath, [entry, mode, userData, project, requestPath, projectLocks], { env: { HOME: root, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk })
    try {
      const [code, signal] = await once(child, 'close')
      expect({ code, signal, stderr }).toEqual({ code: mode === 'after-intent' ? 77 : 78, signal: null, stderr: '' })
      const path = join(project, '.scry-workflows', draft.templateId + '.json')
      const before = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (mode === 'after-intent') expect(before).toBeNull()
      else expect(await readFile(path, 'utf8')).toBe(draft.source)
      const cold = new WorkflowTemplateStore(userData, authorize, projectLocks)
      const result = await cold.publish(request)
      if (mode === 'after-intent') {
        expect(result.state).toBe('unknown')
        await expect(stat(join(project, '.scry-workflows'))).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(result).toMatchObject({ state: 'published', verification: 'reconciled_content' })
        const after = await stat(path)
        expect(after.ino).toBe(before!.ino)
        expect(after.mtimeMs).toBe(before!.mtimeMs)
        expect(await readFile(path, 'utf8')).toBe(draft.source)
      }
      expect(await cold.publish(request)).toEqual(result)
    } finally { await stopOwned(child) }
  })
})
