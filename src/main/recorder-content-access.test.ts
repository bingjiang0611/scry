import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'
import { readAuthorizedRecorderContentPage, RECORDER_CONTENT_PAGE_MAX_BYTES } from './recorder-content-access'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-app-content-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'content-access',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }))
  const payload = (extra: Record<string, unknown>) => ({ session_id: 'session', timestamp: '2026-01-01T00:00:00.000Z', ...extra })
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload({ prompt: 'p' }) })
  await handleRecorderHook({ provider: 'claude', event: 'PreToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'echo' } }) })
  await handleRecorderHook({ provider: 'claude', event: 'PostToolUse', workspace: root, payload: payload({ tool_name: 'Bash', tool_use_id: 'call', tool_response: '前🙂后'.repeat(30_000) }) })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload({ assistant_response: 'done' }) })
  const [record] = await listRecords(join(root, '.scry'))
  return { dataRoot: join(root, '.scry'), ref: record.tools.value![0].outputContent!.contentRef! }
}

describe('authorized recorder content pages', () => {
  it('serves an exact referenced body through bounded byte pages', async () => {
    const { dataRoot, ref } = await fixture()
    const first = await readAuthorizedRecorderContentPage(dataRoot, { ref, offset: 0, limit: 65_535 })
    expect(first).toMatchObject({ offset: 0, nextOffset: 65_535, totalBytes: ref.bytes, hasMore: true })
    const pages = [first]
    while (pages.at(-1)!.hasMore) {
      pages.push(await readAuthorizedRecorderContentPage(dataRoot, {
        ref,
        offset: pages.at(-1)!.nextOffset,
        limit: RECORDER_CONTENT_PAGE_MAX_BYTES
      }))
    }
    expect(Buffer.concat(pages.map((page) => Buffer.from(page.dataBase64, 'base64'))).toString('utf8')).toBe('前🙂后'.repeat(30_000))
  })

  it('rejects refs not present in a validated workspace record and oversized pages', async () => {
    const { dataRoot, ref } = await fixture()
    await expect(readAuthorizedRecorderContentPage(dataRoot, { ref: { ...ref, sha256: 'a'.repeat(64) } })).rejects.toThrow('not_authorized')
    await expect(readAuthorizedRecorderContentPage(dataRoot, { ref, limit: RECORDER_CONTENT_PAGE_MAX_BYTES + 1 })).rejects.toThrow('invalid_recorder_content_limit')
  })
})
