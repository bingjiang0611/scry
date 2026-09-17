import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRecorderContent } from './content-store.js'
import { handleRecorderHook } from './recorder.js'
import { archiveRecords, listRecords } from './store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(toolOutput?: 'summary'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-content-archive-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'archive-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, ...(toolOutput ? { toolOutput } : {}), diff: false, hooks: true }
  }))
  return root
}

async function complete(root: string, sessionId: string, output: string): Promise<void> {
  const base = { provider: 'claude' as const, workspace: root }
  const payload = (extra: Record<string, unknown>) => ({ session_id: sessionId, timestamp: new Date().toISOString(), ...extra })
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload({ prompt: 'archive content' }) })
  await handleRecorderHook({ ...base, event: 'PreToolUse:Bash', payload: payload({ tool_name: 'Bash', tool_use_id: `${sessionId}-call`, tool_input: { command: 'generate' } }) })
  await handleRecorderHook({ ...base, event: 'PostToolUse:Bash', payload: payload({ tool_name: 'Bash', tool_use_id: `${sessionId}-call`, tool_response: output }) })
  await handleRecorderHook({ ...base, event: 'Stop', payload: payload({}) })
}

function contentPath(root: string, sha256: string): string {
  return join(root, 'content', 'sha256', sha256.slice(0, 2), `${sha256}.bin`)
}

describe('Recorder content archive', () => {
  it('copies deduplicated referenced bodies so the archive resolves without the live store', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive')
    const output = `${'共享😀'.repeat(4_000)}\nARCHIVE_TAIL`
    await complete(root, 'one', output)
    await complete(root, 'two', output)

    const before = await listRecords(dataRoot)
    const outputRefs = before.map((record) => record.tools.value![0].outputContent!.contentRef!)
    expect(outputRefs[0]).toEqual(outputRefs[1])
    await archiveRecords(dataRoot, { throughSequence: 2, target })
    await rm(join(dataRoot, 'content'), { recursive: true, force: true })

    const archived = await listRecords(target)
    expect(archived).toHaveLength(2)
    expect(await readRecorderContent(target, archived[0].tools.value![0].outputContent!.contentRef!))
      .toBe(output)
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    expect(manifest.contents.filter((ref: { sha256: string }) => ref.sha256 === outputRefs[0].sha256)).toHaveLength(1)
  })

  it('fails before journaling when a referenced source blob is missing', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await complete(root, 'missing', 'body'.repeat(3_000))
    const [record] = await listRecords(dataRoot)
    const ref = record.tools.value![0].outputContent!.contentRef!
    await rm(contentPath(dataRoot, ref.sha256))

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target: join(root, 'archive-missing') }))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(dataRoot, 'archive-journal.json'))).rejects.toThrow()
    expect(await listRecords(dataRoot)).toHaveLength(1)
  })

  it('resumes from target content after publication even if the live blob disappears', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-recovery')
    await complete(root, 'recovery', 'recoverable'.repeat(2_000))
    let faulted = false
    await expect(archiveRecords(dataRoot, {
      throughSequence: 1,
      target,
      onStep: (phase) => {
        if (!faulted && phase === 'target-published') {
          faulted = true
          throw new Error('simulated crash')
        }
      }
    })).rejects.toThrow('simulated crash')
    await rm(join(dataRoot, 'content'), { recursive: true, force: true })

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target })).resolves.toMatchObject({ archivedThrough: 1 })
    const [record] = await listRecords(target)
    await expect(readRecorderContent(target, record.tools.value![0].outputContent!.contentRef!)).resolves.toContain('recoverable')
  })

  it('keeps legacy inline-only archives valid with an empty content manifest', async () => {
    const root = await workspace('summary')
    const target = join(root, 'archive-legacy')
    await complete(root, 'legacy', 'inline only')
    await archiveRecords(join(root, '.scry'), { throughSequence: 1, target })
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    expect(manifest.contents).toEqual([])
  })
})
