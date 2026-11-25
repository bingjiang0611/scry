import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { recorderSessionRoot, recorderStatePath } from '../runtime-state'
import { diffAt, gitWorkspace } from './worktree-fixture'
import {
  assistantText, launchReceipt, notification, notificationPrompt, sealQuietSegment, session, start, stop, toolUse, user
} from './state-machine-continuation-fixture'

const stateFile = (root: string): string =>
  recorderStatePath(recorderSessionRoot(join(root, '.scry'), 'qoder', session))

const frozen = async (root: string): Promise<Array<{ tempDir: string; tree: string }>> => {
  const state = JSON.parse(await readFile(stateFile(root), 'utf8')) as {
    lastSegment?: { frozenDiffs?: Array<{ tempDir: string; tree: string }> }
  }
  return state.lastSegment?.frozenDiffs ?? []
}

const chainStores = async (root: string): Promise<string[]> =>
  ((JSON.parse(await readFile(stateFile(root), 'utf8')) as { chainStores?: string[] }).chainStores ?? [])

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

export function registerSegmentDiffSuite(): void {
  it('同一次提问、两次唤醒、每段改一个文件：三条记录的 diff 各自只含本段改动，合起来不重不漏', async () => {
    const root = await gitWorkspace(false)
    const transcript = join(await mkdtemp(join(tmpdir(), 'scry-segment-diff-')), 'qoder.jsonl')
    const hook = (event: string, payload: Record<string, unknown>) =>
      handleRecorderHook({ provider: 'qoder', event, workspace: root, payload })
    await writeFile(transcript, `${[
      user('prompt-1', 'ship the release', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Release build started in the background.')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-1', 'ship the release', '2026-07-19T12:00:00.000Z'))
    await writeFile(join(root, 'first.txt'), 'one\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)
    const firstStore = await frozen(root)
    expect(firstStore).toHaveLength(1)

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Build finished; applying the fix.'),
      toolUse('prompt-2', 'call-bg-2', 'sleep 300'),
      launchReceipt('call-bg-2', 'task-2')
    ].join('\n')}\n`)
    await expect(hook('UserPromptSubmit', start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z')))
      .resolves.toMatchObject({ status: 'started' })
    await writeFile(join(root, 'second.txt'), 'two\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)
    const secondStore = await frozen(root)
    expect(secondStore).toHaveLength(1)
    expect(secondStore[0].tempDir).not.toBe(firstStore[0].tempDir)
    const afterSecond = await chainStores(root)
    expect(afterSecond).toHaveLength(2)
    for (const dir of afterSecond) await expect(exists(dir)).resolves.toBe(true)

    await appendFile(transcript, `${[
      notification('prompt-3', 'task-2', 'call-bg-2'),
      assistantText('prompt-3', 'Verification finished; the release is out.')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-3', notificationPrompt('task-2', 'call-bg-2'), '2026-07-19T12:00:42.000Z'))
    await writeFile(join(root, 'third.txt'), 'three\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => record.turnIndex)).toEqual([1, 2, 3])
    expect(records.map((record) => record.diff.status)).toEqual(['available', 'available', 'available'])
    const changed = records.map((record) => diffAt(record, root).files.map((file) => basename(file.path)).sort())
    expect(changed).toEqual([['first.txt'], ['second.txt'], ['third.txt']])
    for (const record of records.slice(1)) {
      expect(record.turnRole).toMatchObject({ role: 'continuation', parentId: records[0].recordId })
      expect(record.user.status).toBe('unavailable')
    }
    expect(await frozen(root)).toHaveLength(1)
    expect(await chainStores(root)).toHaveLength(3)
  }, 20_000)

  it('三段链：中间段不动上一段新建的文件，第三段改它时仍能解析出本段 diff', async () => {
    const root = await gitWorkspace(false)
    const transcript = join(await mkdtemp(join(tmpdir(), 'scry-segment-diff-chain-')), 'qoder.jsonl')
    const hook = (event: string, payload: Record<string, unknown>) =>
      handleRecorderHook({ provider: 'qoder', event, workspace: root, payload })
    await writeFile(transcript, `${[
      user('prompt-1', 'chain the segments', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-1', 'chain the segments', '2026-07-19T12:00:00.000Z'))
    await writeFile(join(root, 'first.txt'), 'one\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      toolUse('prompt-2', 'call-bg-2', 'sleep 300'),
      launchReceipt('call-bg-2', 'task-2')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z'))
    await writeFile(join(root, 'second.txt'), 'two\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)

    await appendFile(transcript, `${[
      notification('prompt-3', 'task-2', 'call-bg-2')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-3', notificationPrompt('task-2', 'call-bg-2'), '2026-07-19T12:00:42.000Z'))
    await writeFile(join(root, 'first.txt'), 'one, edited later\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => record.diff.status)).toEqual(['available', 'available', 'available'])
    const patch = diffAt(records[2], root).files[0].patchContent?.content ?? ''
    expect(patch).toContain('-one')
    expect(patch).toContain('+one, edited later')
  }, 20_000)

  it('接续段只算自己改的文件：上一段开始前就没提交的改动不重复计入', async () => {
    const root = await gitWorkspace(false)
    const transcript = join(await mkdtemp(join(tmpdir(), 'scry-segment-diff-dirty-')), 'qoder.jsonl')
    const hook = (event: string, payload: Record<string, unknown>) =>
      handleRecorderHook({ provider: 'qoder', event, workspace: root, payload })
    await writeFile(join(root, 'a.txt'), 'dirty before the turn\n')
    await writeFile(transcript, `${[
      user('prompt-1', 'fix it while the build runs', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-1', 'fix it while the build runs', '2026-07-19T12:00:00.000Z'))
    await writeFile(join(root, 'first.txt'), 'one\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Build finished; finishing the fix.')
    ].join('\n')}\n`)
    await hook('UserPromptSubmit', start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z'))
    await writeFile(join(root, 'a.txt'), 'fixed in the second segment\n')
    await expect(hook('Stop', stop(transcript))).resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    expect(records.map((record) => diffAt(record, root).files.map((file) => basename(file.path)).sort()))
      .toEqual([['first.txt'], ['a.txt']])
  }, 20_000)
}
