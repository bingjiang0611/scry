import { writeFile, readFile, mkdir, chmod, realpath, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, vi, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { safeKey, listRecords, archiveRecords } from '../store'
import { readRecorderContent } from '../content-store'
import { workspace, pexecFile, payload } from './fixture.test'

export function registerSuite17(): void {


describe('nested Git turn diff', () => {
  it('昂贵 Git 快照期间先持久化 open turn', async () => {
    const root = await workspace()
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', 'a.txt'], { cwd: root })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'after\n')
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    // Snapshots disable repository filters. Synchronize the real Git invocation,
    // not a filter sleep that the production trust boundary deliberately bypasses.
    const realGit = (await pexecFile('which', ['git'])).stdout.trim()
    const syncDir = join(root, 'snapshot-sync')
    const binDir = join(root, 'bin')
    await mkdir(binDir)
    await mkdir(syncDir)
    const readyPipe = join(syncDir, 'snapshot-ready')
    const releasePipe = join(syncDir, 'snapshot-release')
    await pexecFile('mkfifo', [readyPipe])
    await pexecFile('mkfifo', [releasePipe])
    const gitWrapper = join(binDir, 'git')
    await writeFile(gitWrapper, `#!/bin/sh
has_add=0
has_all=0
for arg in "$@"; do
  [ "$arg" = "add" ] && has_add=1
  [ "$arg" = "-A" ] && has_all=1
done
if [ -n "$SCRY_TEST_SYNC_DIR" ] && [ "$has_add" = 1 ] && [ "$has_all" = 1 ]; then
  printf 'ready\\n' > "$SCRY_TEST_READY_PIPE"
  read _release < "$SCRY_TEST_RELEASE_PIPE"
fi
exec "$SCRY_TEST_REAL_GIT" "$@"
`)
    await chmod(gitWrapper, 0o700)
    vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
    vi.stubEnv('SCRY_TEST_REAL_GIT', realGit)
    vi.stubEnv('SCRY_TEST_SYNC_DIR', syncDir)
    vi.stubEnv('SCRY_TEST_READY_PIPE', readyPipe)
    vi.stubEnv('SCRY_TEST_RELEASE_PIPE', releasePipe)
    const ready = readFile(readyPipe, 'utf8')
    let settled = false
    const starting = handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', { prompt: 'synchronized snapshot' }),
      env: { ...process.env }
    }).finally(() => { settled = true })
    await ready
    try {
      const open = JSON.parse(await readFile(join(root, '.scry', 'runtime', 'qoder', safeKey('q1'), 'open.json'), 'utf8'))
      expect(open).toMatchObject({ status: 'open', captures: [] })
      expect(settled).toBe(false)
    } finally {
      // An assertion failure must still release the owned Git process.
      await writeFile(releasePipe, 'release\n')
      await starting
    }
    await expect(starting).resolves.toMatchObject({ status: 'started' })
    const captured = JSON.parse(await readFile(join(root, '.scry', 'runtime', 'qoder', safeKey('q1'), 'open.json'), 'utf8'))
    expect(captured.captures).toContainEqual(expect.objectContaining({
      capture: expect.objectContaining({ status: 'ready', beforeTree: expect.any(String) })
    }))
  }, 15_000)

  it('按真实子仓归属记录本轮净变化', async () => {
    const root = await workspace()
    const repository = join(root, 'plugin-commerce-app')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(repository))
    await pexecFile('git', ['init'], { cwd: repository })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: repository })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', '.'], { cwd: repository })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: repository })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.repositories = { mode: 'discover-nested-git', maxDepth: 2 }
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'opencode', event: 'chat.message', workspace: root, payload: payload('o1', { prompt: 'edit nested repo' }) })
    await writeFile(join(repository, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'opencode', event: 'session.idle', workspace: root, payload: payload('o1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff).toMatchObject({ status: 'available', quality: 'exact' })
    const canonicalRepository = await realpath(repository)
    expect(record.diff.value?.[0]).toMatchObject({ status: 'captured', repoRoot: canonicalRepository })
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(canonicalRepository, 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 35_000)

  it('大 Diff 完整内联并以内容引用保留 Unicode patch', async () => {
    const root = await workspace()
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    await writeFile(join(root, 'large.txt'), 'before\n')
    await pexecFile('git', ['add', 'large.txt'], { cwd: root })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('large-diff', { prompt: 'edit large diff' }) })
    const completeBody = `${Array.from({ length: 12_000 }, (_, index) => `第${index}行😀`).join('\n')}\nEND-OF-FULL-PATCH\n`
    await writeFile(join(root, 'large.txt'), completeBody)
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('large-diff', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    const file = record.diff.value?.[0].files[0]
    expect(file).toMatchObject({ patchStatus: 'captured', patchContent: { storage: 'complete', sourceCompleteness: 'complete' } })
    expect(Buffer.byteLength(file?.patch ?? '')).toBeGreaterThan(32 * 1024)
    expect(file?.patchContent?.contentRef?.bytes).toBeGreaterThan(32 * 1024)
    const dataRoot = join(root, '.scry')
    const fullPatch = await readRecorderContent(dataRoot, file!.patchContent!.contentRef!)
    expect(fullPatch).toContain('第11999行😀')
    expect(fullPatch).toContain('END-OF-FULL-PATCH')

    const target = join(root, 'diff-archive')
    await archiveRecords(dataRoot, { throughSequence: 1, target })
    await rm(join(dataRoot, 'content'), { recursive: true, force: true })
    const [archived] = await listRecords(target)
    await expect(readRecorderContent(target, archived.diff.value![0].files[0].patchContent!.contentRef!))
      .resolves.toBe(fullPatch)
  }, 35_000)

  it('接入方通过 Git exclude 忽略 .scry 时仍能采集业务 Diff', async () => {
    const root = await workspace()
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', 'a.txt'], { cwd: root })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
    await appendFile(join(root, '.git', 'info', 'exclude'), '\n.scry/\n')
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'edit root' }) })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(await realpath(root), 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 35_000)
})
}
