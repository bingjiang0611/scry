import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, pexecFile, payload } from './fixture.test'

async function gitRepo(root: string): Promise<void> {
  await pexecFile('git', ['init'], { cwd: root })
  await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
  await writeFile(join(root, 'a.txt'), 'before\n')
  await writeFile(join(root, 'tracked.txt'), 'unchanged\n')
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  config.capture.diff = true
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
  await pexecFile('git', ['add', '-A'], { cwd: root })
  await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
}

async function gitRecorder(): Promise<string> {
  const realGit = (await pexecFile('which', ['git'])).stdout.trim()
  const scratch = await mkdtemp(join(tmpdir(), 'scry-git-log-'))
  const binDir = join(scratch, 'bin')
  const log = join(scratch, 'git-calls.log')
  await mkdir(binDir, { recursive: true })
  const wrapper = join(binDir, 'git')
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`)
  await chmod(wrapper, 0o700)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
  return log
}

async function gitCalls(log: string): Promise<string[]> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
}

export function registerDiffPrefilterSuite(): void {
  it('干净且没有改动的仓库：一轮只读一次 status，不跑完整采集', async () => {
    const root = await workspace()
    await gitRepo(root)
    const log = await gitRecorder()
    try {
      await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('prefilter', { prompt: 'just answer' }) })
      const endStart = (await gitCalls(log)).length
      await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('prefilter', { timestamp: '2026-07-19T12:00:01.000Z' }) })
      const endCalls = (await gitCalls(log)).slice(endStart)
      const [record] = await listRecords(join(root, '.scry'))
      expect(record.diff).toMatchObject({ status: 'available' })
      const snapshot = record.diff.value![0]
      expect(snapshot).toMatchObject({ status: 'captured', files: [], collection: { strategy: 'unchanged', evidence: 'git_status', candidatePathCount: 0 } })
      expect(endCalls.filter((call) => /(^| )add -A( |$)/.test(call) || /write-tree/.test(call) || /read-tree/.test(call) || /update-index/.test(call))).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  }, 35_000)

  it('开始时干净、本轮里被改动：diff 完整，包含修改、新增文件和本轮提交', async () => {
    const root = await workspace()
    await gitRepo(root)
    const log = await gitRecorder()
    try {
      await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('prefilter', { prompt: 'change things' }) })
      await writeFile(join(root, 'a.txt'), 'after\n')
      await writeFile(join(root, 'added.txt'), 'new file\n')
      await writeFile(join(root, 'tracked.txt'), 'committed\n')
      await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'mid-turn commit'], { cwd: root })
      await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('prefilter', { timestamp: '2026-07-19T12:00:01.000Z' }) })

      const [record] = await listRecords(join(root, '.scry'))
      const snapshot = record.diff.value![0]
      expect(snapshot.status).toBe('captured')
      expect(snapshot.collection?.strategy).not.toBe('unchanged')
      const paths = (snapshot.files ?? []).map((file) => file.path.split('/').at(-1)).sort()
      expect(paths).toEqual(['a.txt', 'added.txt', 'tracked.txt'])
      const tracked = snapshot.files?.find((file) => file.path.endsWith('tracked.txt'))
      expect(tracked).toMatchObject({ added: 1, deleted: 1 })
      expect(tracked?.patchContent?.content).toContain('+committed')
    } finally {
      vi.unstubAllEnvs()
    }
  }, 35_000)

  it('工具事件点名了仓库内路径：即使看起来干净也走完整采集，不靠 status 猜测', async () => {
    const root = await workspace()
    await gitRepo(root)
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('prefilter', { prompt: 'touch one file' }) })
    await handleRecorderHook({
      provider: 'codex', event: 'PostToolUse', workspace: root,
      payload: payload('prefilter', {
        tool_name: 'Edit', tool_use_id: 'tool-1',
        tool_input: { file_path: join(root, 'a.txt') }, tool_response: 'ok'
      })
    })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('prefilter', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    const snapshot = record.diff.value![0]
    expect(snapshot.collection?.strategy).toBe('targeted')
    expect(snapshot.files).toEqual([expect.objectContaining({ path: expect.stringContaining('a.txt'), added: 1, deleted: 1 })])
  }, 35_000)

  it('index 把文件标成 assume-unchanged 时仍捕获本轮改动，不让 status 的静默变成漏报', async () => {
    const root = await workspace()
    await gitRepo(root)
    await pexecFile('git', ['update-index', '--assume-unchanged', 'a.txt'], { cwd: root })
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('prefilter', { prompt: 'edit the hidden file' }) })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('prefilter', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    const snapshot = record.diff.value![0]
    expect(snapshot.collection?.strategy).not.toBe('unchanged')
    expect(snapshot.files).toEqual([expect.objectContaining({ path: expect.stringContaining('a.txt'), added: 1, deleted: 1 })])
  }, 35_000)

  it('开始时已经有改动：仍按起点快照计，只报本轮改动', async () => {
    const root = await workspace()
    await gitRepo(root)
    await writeFile(join(root, 'tracked.txt'), 'pre-existing dirty\n')
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('prefilter', { prompt: 'edit another file' }) })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('prefilter', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    const snapshot = record.diff.value![0]
    expect(snapshot.collection?.strategy).not.toBe('unchanged')
    expect((snapshot.files ?? []).map((file) => file.path.split('/').at(-1))).toEqual(['a.txt'])
  }, 35_000)
}
