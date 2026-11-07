import { afterAll, describe, expect, it } from 'vitest'
import { beginGitTurnDiff, cleanupCapture } from './git-capture.js'
import {
  captureRootFor,
  commitAll,
  finishCapture,
  git,
  newRepoRoot,
  referenceTree,
  relativeFiles,
  removeTrackedRoots,
  stamp,
  writeFileAt,
  type OracleRun
} from './git-snapshot-oracle-harness.js'

// Oracle part three: state that changes *between* turns. The next turn's beforeTree must be
// rebuilt from the current worktree, never inherited from the previous turn's after tree.
// This is the guard for cross-turn index seeding: a seed may only skip work whose stat
// signature proves the file unchanged.

afterAll(async () => { await removeTrackedRoots() })

async function begin(root: string, repo: string) {
  const capture = await beginGitTurnDiff(repo, 20_000, captureRootFor(root), [])
  if (capture.status !== 'ready') throw new Error(`capture not ready: ${capture.status}/${capture.reason ?? ''}`)
  return capture
}

/** One complete turn: capture the baseline, mutate, then build the after tree. */
async function turn(root: string, repo: string, mutate: (repo: string) => Promise<void>): Promise<OracleRun> {
  const capture = await begin(root, repo)
  try {
    await mutate(repo)
    return await finishCapture(capture, false, 20_000)
  } finally {
    await cleanupCapture(capture)
  }
}

describe('git snapshot oracle: state changes between turns', () => {
  it('o15 an external stat-blind edit between turns is inside the next beforeTree', async () => {
    const { root, repo } = await newRepoRoot('o15-between')
    await writeFileAt(repo, 'first.txt', 'aaaa\n')
    await writeFileAt(repo, 'second.txt', 'bbbb\n')
    await stamp(repo, 'first.txt')
    await stamp(repo, 'second.txt')
    await commitAll(repo)

    const firstRun = await turn(root, repo, async (cwd) => { await writeFileAt(cwd, 'first.txt', 'aaaa2\n') })
    expect(relativeFiles(firstRun.files, repo).map((file) => file.path)).toEqual(['first.txt'])

    // External edit while no turn is running: same size, mtime restored, so a stat-only seed
    // would happily reuse the old index entry.
    await writeFileAt(repo, 'second.txt', 'cccc\n')
    await stamp(repo, 'second.txt')

    const expectedTree = await referenceTree(root, repo)
    const capture = await begin(root, repo)
    try {
      expect(capture.beforeTree).toBe(expectedTree)
      // A working-tree tree, not a committed one: the external edit is uncommitted.
      expect(capture.beforeTree).not.toBe((await git(['rev-parse', 'HEAD'], repo)).trim())

      const secondRun = await finishCapture(capture, false, 20_000)
      // Nothing changed during turn 2, so its diff is empty even though the baseline moved.
      expect(secondRun.files).toEqual([])
      expect(secondRun.tree).toBe(capture.beforeTree)
    } finally {
      await cleanupCapture(capture)
    }

    const thirdRun = await turn(root, repo, async (cwd) => { await writeFileAt(cwd, 'third.txt', 'new\n') })
    expect(relativeFiles(thirdRun.files, repo).map((file) => file.path)).toEqual(['third.txt'])
  }, 120_000)

  it('o16a commit between turns moves the next baseline to the new HEAD', async () => {
    const { root, repo } = await newRepoRoot('o16-commit')
    await writeFileAt(repo, 'a.txt', 'v1\n')
    await commitAll(repo)
    await turn(root, repo, async (cwd) => { await writeFileAt(cwd, 'a.txt', 'v2\n') })
    await commitAll(repo, 'after turn one')
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim()
    const capture = await begin(root, repo)
    try {
      expect(capture.beforeTree).toBe(head)
      const run = await finishCapture(capture, false, 20_000)
      expect(run.files).toEqual([])
    } finally {
      await cleanupCapture(capture)
    }
  }, 120_000)

  it('o16b branch switch between turns moves the next baseline to the new branch', async () => {
    const { root, repo } = await newRepoRoot('o16-branch')
    await writeFileAt(repo, 'a.txt', 'main\n')
    await commitAll(repo)
    await git(['checkout', '-q', '-b', 'feature'], repo)
    await writeFileAt(repo, 'a.txt', 'feature\n')
    await commitAll(repo, 'feature change')
    await git(['checkout', '-q', 'main'], repo)
    await turn(root, repo, async (cwd) => { await writeFileAt(cwd, 'scratch.txt', 'temp\n') })
    // Untracked files survive a checkout; remove it so the baseline is exactly the branch tree.
    await git(['clean', '-q', '-fd'], repo)
    await git(['checkout', '-q', 'feature'], repo)
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim()
    const capture = await begin(root, repo)
    try {
      expect(capture.beforeTree).toBe(head)
      const run = await finishCapture(capture, false, 20_000)
      expect(run.files).toEqual([])
    } finally {
      await cleanupCapture(capture)
    }
  }, 120_000)

  it('o16c stash between turns returns the baseline to a clean HEAD tree', async () => {
    const { root, repo } = await newRepoRoot('o16-stash')
    await writeFileAt(repo, 'a.txt', 'v1\n')
    await commitAll(repo)
    await turn(root, repo, async (cwd) => { await writeFileAt(cwd, 'a.txt', 'v2 uncommitted\n') })
    await git(['stash', 'push', '-q', '-u', '-m', 'between turns'], repo)
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim()
    const capture = await begin(root, repo)
    try {
      expect(capture.beforeTree).toBe(head)
      const run = await finishCapture(capture, false, 20_000)
      expect(run.files).toEqual([])
    } finally {
      await cleanupCapture(capture)
    }
  }, 120_000)
})
