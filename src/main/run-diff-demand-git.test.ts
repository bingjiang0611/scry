import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { beginGitTurnDiff, cancelGitTurnDiff, cloneGitTurnDiffCapture, finishGitTurnAndSessionDiff, previewGitTurnDiff, type GitTurnDiffCapture } from './git'
import { RunDiffPreviewer } from './run-diff-previewer'
const exec = promisify(execFile)

it('retains full terminal turn/session patches and the user index when no view ever requests a preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-diff-never-viewed-'))
  let turn: GitTurnDiffCapture | undefined, session: GitTurnDiffCapture | undefined
  const git = (...args: string[]) => exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  try {
    await git('init', '-q')
    await git('config', 'user.name', 'bingjiang0611')
    await git('config', 'user.email', '307659028+bingjiang0611@users.noreply.github.com')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await writeFile(join(root, 'removed.txt'), 'removed evidence\n')
    await git('add', '.')
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'fixture')
    const index = await readFile(join(root, '.git/index'))
    turn = await beginGitTurnDiff(root)
    session = await cloneGitTurnDiffCapture(turn)
    const preview = vi.fn(previewGitTurnDiff), emit = vi.fn()
    const view = new RunDiffPreviewer({ runId: 'never-viewed', turnCapture: Promise.resolve(turn), sessionCapture: Promise.resolve(session), hints: () => ({}), preview, emit })
    await view.setDemanded(false)
    const tracked = '完整 final tracked 数据 '.repeat(128), untracked = '完整 untracked 数据 '.repeat(128)
    await writeFile(join(root, 'tracked.txt'), tracked)
    await writeFile(join(root, 'new.txt'), untracked)
    await unlink(join(root, 'removed.txt'))
    await view.notifyChange()
    view.sealAll()
    await view.idle()
    const pair = finishGitTurnAndSessionDiff(turn, session)
    const [final, net] = await Promise.all([pair.turn, pair.session])
    expect(preview).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(final.status).toBe('captured')
    expect(net.status).toBe('captured')
    expect(final.files).toEqual(net.files)
    expect(final.files?.map(file => file.path).sort()).toEqual(['new.txt', 'removed.txt', 'tracked.txt'].map(name => join(turn!.repoRoot!, name)))
    expect(final.files?.find(file => file.path.endsWith('/tracked.txt'))?.patch).toContain(tracked)
    expect(final.files?.find(file => file.path.endsWith('/new.txt'))?.patch).toContain(untracked)
    expect(final.files?.find(file => file.path.endsWith('/removed.txt'))?.patch).toContain('-removed evidence')
    expect(await readFile(join(root, '.git/index'))).toEqual(index)
  } finally {
    if (turn) await cancelGitTurnDiff(turn)
    if (session) await cancelGitTurnDiff(session)
    await rm(root, { recursive: true, force: true })
  }
})
