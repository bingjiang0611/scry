import { chmod, copyFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { beginGitTurnDiff, cleanupCapture } from './git-capture.js'
import {
  captureRootFor,
  commitAll,
  finishCapture,
  git,
  gitWith,
  removeTrackedRoots,
  runScenarioPair,
  runTurn,
  expectIndexAndObjectsUntouched,
  expectSameEvidence,
  newRepoRoot,
  stamp,
  writeFileAt,
  type Scenario
} from './git-snapshot-oracle-harness.js'

// Oracle: the targeted after-tree path and the full `writeSnapshotTree` path must produce the
// same tree, the same file evidence and the same patch bytes on the same worktree state, and
// neither may write the user's real index or object database. A mismatch here is a correctness
// defect in the implementation under test, not a licence to relax the assertion.

afterAll(async () => { await removeTrackedRoots() })

const scenarios: Scenario[] = [
  {
    // O1 basic modify/add/delete.
    id: 'o1-basic',
    setup: async (repo) => {
      await writeFileAt(repo, 'keep.txt', 'keep\n')
      await writeFileAt(repo, 'edit.txt', 'one\ntwo\nthree\n')
      await writeFileAt(repo, 'gone.txt', 'bye\n')
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await writeFileAt(repo, 'edit.txt', 'one\nTWO\nthree\nfour\n')
      await writeFileAt(repo, 'added.txt', 'new\n')
      await rm(join(repo, 'gone.txt'))
    }
  },
  {
    // O3 file <-> directory replacement in the same turn.
    id: 'o3-file-directory',
    setup: async (repo) => {
      await writeFileAt(repo, 'swap', 'plain file\n')
      await writeFileAt(repo, 'tree/inner.txt', 'inner\n')
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await rm(join(repo, 'swap'))
      await writeFileAt(repo, 'swap/child.txt', 'now a directory\n')
      await rm(join(repo, 'tree'), { recursive: true })
      await writeFileAt(repo, 'tree', 'now a file\n')
    }
  },
  {
    // O4 symlink: retarget, add, and replace with a regular file.
    id: 'o4-symlink',
    setup: async (repo) => {
      await writeFileAt(repo, 'one.txt', 'one\n')
      await writeFileAt(repo, 'two.txt', 'two\n')
      await symlink('one.txt', join(repo, 'current.txt'))
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await rm(join(repo, 'current.txt'))
      await symlink('two.txt', join(repo, 'current.txt'))
      await symlink('one.txt', join(repo, 'fresh.txt'))
      await rm(join(repo, 'one.txt'))
      await writeFileAt(repo, 'one.txt', 'one\n')
    }
  },
  {
    // O5 executable bit only.
    id: 'o5-mode',
    setup: async (repo) => {
      await writeFileAt(repo, 'run.sh', '#!/bin/sh\necho hi\n')
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await chmod(join(repo, 'run.sh'), 0o755)
    }
  },
  {
    // O11 paths with spaces, newlines, quotes and non-UTF-8 bytes.
    id: 'o11-paths',
    setup: async (repo) => {
      await writeFileAt(repo, 'with space.txt', 'a\n')
      await writeFileAt(repo, "quote\"and'.txt", 'b\n')
      await writeFileAt(repo, 'new\nline.txt', 'c\n')
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await writeFileAt(repo, 'with space.txt', 'a2\n')
      await writeFileAt(repo, "quote\"and'.txt", 'b2\n')
      await writeFileAt(repo, 'new\nline.txt', 'c2\n')
      // Non-ASCII path: macOS APFS rejects invalid UTF-8 file names (EILSEQ), so this covers
      // multi-byte UTF-8 rather than raw non-UTF-8 bytes. `-z` keeps it unquoted either way.
      await writeFileAt(repo, '中文 名✨.txt', 'd\n')
    }
  },
  {
    // O12 binary content including the NUL git uses to detect binaries.
    id: 'o12-binary',
    setup: async (repo) => {
      await writeFile(join(repo, 'blob.bin'), Buffer.from('text start\n'))
      await commitAll(repo)
    },
    mutate: async (repo) => {
      await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x0a, 0x00]))
    }
  },
  {
    // O13 assume-unchanged and skip-worktree marks already on the real index.
    id: 'o13-index-marks',
    setup: async (repo) => {
      await writeFileAt(repo, 'assumed.txt', 'v1\n')
      await writeFileAt(repo, 'skipped.txt', 'v1\n')
      await commitAll(repo)
    },
    prepare: async (repo) => {
      await git(['update-index', '--assume-unchanged', 'assumed.txt'], repo)
      await git(['update-index', '--skip-worktree', 'skipped.txt'], repo)
    },
    mutate: async (repo) => {
      await writeFileAt(repo, 'assumed.txt', 'v2 changed\n')
      await writeFileAt(repo, 'skipped.txt', 'v2 changed\n')
    }
  }
]

describe('git snapshot oracle: worktree shape and encoding', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: targeted equals full and leaves the real repository untouched`, async () => {
      await runScenarioPair(scenario)
    }, 60_000)
  }
})

/**
 * Racy-clean fixture: content with the same size and the same mtime, rewritten inside the same
 * wall-clock second as the `git add` that recorded the index entry. Git compares index stat
 * data at one-second granularity, so `update-index --refresh` cannot see the new bytes; only a
 * tree rebuilt from a cleared stat cache (the full path) hashes them.
 *
 * The window is a race with the clock, so the fixture is rebuilt until the blindness is proven
 * with the real binary before the pair is run. It never asserts a pass: it records a known defect.
 */
async function buildStatBlindRacyRepo(label: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const { repo } = await newRepoRoot(`${label}-${attempt}`)
    await writeFileAt(repo, 'racy.txt', 'aaaa\n')
    await stamp(repo, 'racy.txt')
    await commitAll(repo)
    await writeFileAt(repo, 'racy.txt', 'bbbb\n')
    await stamp(repo, 'racy.txt')
    // Prove the stat-cached refresh is blind to the change before trusting the fixture.
    const probe = join(repo, '..', 'probe.index')
    await copyFile(join(repo, '.git', 'index'), probe)
    const env = { GIT_INDEX_FILE: probe }
    await gitWith(['update-index', '--really-refresh'], repo, env).catch(() => undefined)
    const status = await gitWith(['status', '--porcelain=v1', '-z', '--', 'racy.txt'], repo, env)
    if (status === '') return repo
  }
  throw new Error('could not construct a stat-blind racy-clean fixture (index stat matched the change)')
}

describe('git snapshot oracle: racy-clean (known defect)', () => {
  it.fails(
    'o2 racy-clean: same-size, same-mtime content change must not be invisible to the targeted path',
    async () => {
      const targetedRepo = await buildStatBlindRacyRepo('o2-targeted')
      const fullRepo = await buildStatBlindRacyRepo('o2-full')
      const noop = async () => {}
      const targeted = await runTurn(join(targetedRepo, '..'), targetedRepo, { forceFull: false }, noop)
      const full = await runTurn(join(fullRepo, '..'), fullRepo, { forceFull: true }, noop)
      expectIndexAndObjectsUntouched(targeted, full)
      expectSameEvidence(targeted, full, targetedRepo, fullRepo)
    },
    180_000
  )
})

describe('git snapshot oracle: linked worktree', () => {
  it('o14 linked worktree: capture from the worktree path matches the full path', async () => {
    const left = await newRepoRoot('o14-worktree-targeted')
    const right = await newRepoRoot('o14-worktree-full')
    const worktrees: string[] = []
    for (const [index, fixture] of [left, right].entries()) {
      await writeFileAt(fixture.repo, 'tracked.txt', 'v1\n')
      await commitAll(fixture.repo)
      const tree = join(fixture.root, 'wt')
      await git(['worktree', 'add', '-q', '-b', `feature-${index}`, tree], fixture.repo)
      worktrees.push(tree)
    }
    const mutate = async (cwd: string) => { await writeFileAt(cwd, 'tracked.txt', 'v2 in worktree\n') }
    const targeted = await runTurn(left.root, worktrees[0], { forceFull: false }, mutate)
    const full = await runTurn(right.root, worktrees[1], { forceFull: true }, mutate)
    expectIndexAndObjectsUntouched(targeted, full)
    expectSameEvidence(targeted, full, worktrees[0], worktrees[1])
  }, 60_000)
})

describe('git snapshot oracle: the reused discovery base', () => {
  // G1-1 publishes discovery.index as the after index only when its content already equals
  // beforeTree. Prove that precondition directly for a clean and a dirty baseline instead of
  // trusting the comment: `write-tree` over the surviving discovery index must yield beforeTree.
  for (const dirty of [false, true]) {
    it(`discovery.index equals beforeTree (${dirty ? 'dirty' : 'clean'} baseline)`, async () => {
      const { root, repo } = await newRepoRoot(`discovery-base-${dirty ? 'dirty' : 'clean'}`)
      await writeFileAt(repo, 'tracked.txt', 'v1\n')
      await writeFileAt(repo, 'other.txt', 'v1\n')
      await commitAll(repo)
      if (dirty) await writeFileAt(repo, 'other.txt', 'v1 dirty baseline\n')
      const capture = await beginGitTurnDiff(repo, 20_000, captureRootFor(root), [])
      expect(capture.status).toBe('ready')
      try {
        await writeFileAt(repo, 'tracked.txt', 'v2 in turn\n')
        await finishCapture(capture, false, 20_000)
        const discoveryIndex = join(capture.tempDir!, 'discovery.index')
        const tree = (await gitWith(['write-tree'], repo, {
          GIT_INDEX_FILE: discoveryIndex,
          GIT_OBJECT_DIRECTORY: capture.objectDir!
        })).trim()
        // A clean baseline records HEAD (a commit) as beforeTree; a dirty one records a tree that
        // only exists in the capture's private object store, so alternates must be visible here.
        const expected = (await gitWith(['rev-parse', `${capture.beforeTree}^{tree}`], repo, {
          GIT_OBJECT_DIRECTORY: capture.objectDir!,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs ?? ''
        })).trim()
        expect(tree).toBe(expected)
      } finally {
        await cleanupCapture(capture)
      }
    }, 60_000)
  }
})
