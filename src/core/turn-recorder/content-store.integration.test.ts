import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRecorderContent } from './content-store.js'
import { handleRecorderHook } from './recorder.js'
import { listRecords } from './store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-content-integration-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'content-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, diff: false, hooks: true }
  }))
  return root
}

describe('recorder complete tool content', () => {
  it('associates a complete raw artifact with the committed turn across a cold read', async () => {
    const root = await workspace()
    const sessionId = 'large-output-session'
    const now = new Date().toISOString()
    const base = { provider: 'claude' as const, workspace: root }
    const payload = (extra: Record<string, unknown>) => ({ session_id: sessionId, timestamp: now, ...extra })
    const secret = 'LATE_OUTPUT_SECRET'
    const output = `${'0123456789abcdef'.repeat(2_000)}\nAuthorization: Bearer ${secret}\nCOMPLETE_TAIL`

    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload({ prompt: 'capture all exposed output' }) })
    await handleRecorderHook({
      ...base,
      event: 'PreToolUse:Bash',
      payload: payload({ tool_name: 'Bash', tool_use_id: 'large-call', tool_input: { command: 'generate output' } })
    })
    await handleRecorderHook({
      ...base,
      event: 'PostToolUse:Bash',
      payload: payload({ tool_name: 'Bash', tool_use_id: 'large-call', tool_response: output })
    })
    await handleRecorderHook({ ...base, event: 'Stop', payload: payload({}) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.sessionId).toBe(sessionId)
    const field = record.tools.value![0].outputContent!
    expect(field.savedBytes).toBeLessThanOrEqual(8 * 1024)
    expect(field.contentRef).toBeDefined()
    const complete = await readRecorderContent(join(root, '.scry'), field.contentRef!)
    expect(complete).toContain('COMPLETE_TAIL')
    expect(complete).toBe(output)
    expect(field.redaction).toBe('disabled')

    const recordFiles = await listRecords(join(root, '.scry'))
    expect(recordFiles[0].tools.value![0].outputContent?.contentRef).toEqual(field.contentRef)
    const recordJson = await readFile(join(root, '.scry', 'records', `${String(record.sequence).padStart(20, '0')}-${record.recordId}.json`), 'utf8')
    expect(recordJson).not.toContain(secret)
  })
})
