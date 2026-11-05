import { stat, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  commitAll,
  git,
  gitWith,
  newRepoRoot,
  relativeFiles,
  removeTrackedRoots,
  runScenarioPair,
  runTurn,
  expectIndexAndObjectsUntouched,
  expectSameEvidence,
  stamp,
  writeFileAt,
  type Scenario
} from './git-snapshot-oracle-harness.js'

// Oracle part two: repository states that change how Git itself interprets the worktree
// (sparse checkout, rewritten index, attribute/ignore rules, filter drivers, nested
// repositories and submodules). Every case still compares the implementation under test
// against the full reference path on an identical twin fixture.

afterAll(async () => { await removeTrackedRoots() })

const FIXED_DATE = { GIT_AUTHOR_DATE: '2021-02-03T04:05:06Z', GIT_COMMITTER_DATE: '2021-02-03T04:05:06Z' }

async function commitWithFixedDate(repo: string, message: string): Promise<string> {
  await git(['add', '-A'], repo)
  await gitWith(
    ['-c', 'user.name=oracle', '-c', 'user.email=oracle@scry.local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
    repo,
    FIXED_DATE
  )
  return (await git(['rev-parse', 'HEAD'], repo)).trim()
}

describe('git snapshot oracle: repository interpretation inputs', () => {
  const scenarios: Scenario[] = [
    {
      // O6 sparse checkout: paths outside the cone are skip-worktree, never deletions.
      id: 'o6-sparse',
      setup: async (repo) => {
        await writeFileAt(repo, 'cone/a.txt', 'inside\n')
        await writeFileAt(repo, 'outside/b.txt', 'outside\n')
        await commitAll(repo)
      },
      prepare: async (repo) => {
        await git(['sparse-checkout', 'set', 'cone'], repo)
      },
      mutate: async (repo) => {
        await writeFileAt(repo, 'cone/a.txt', 'inside changed\n')
        await writeFileAt(repo, 'cone/new.txt', 'new in cone\n')
      },
      check: (targeted, _full, repos) => {
        const paths = relativeFiles(targeted.run.files, repos.targeted).map((file) => file.path)
        expect(paths).not.toContain('outside/b.txt')
      }
    },
    {
      // O7 the real index is rewritten by staged work while the turn is running.
      id: 'o7-index-rewrite',
      setup: async (repo) => {
        await writeFileAt(repo, 'staged.txt', 'v1\n')
        await writeFileAt(repo, 'unstaged.txt', 'v1\n')
        await commitAll(repo)
      },
      mutate: async (repo) => {
        await writeFileAt(repo, 'staged.txt', 'v2 staged\n')
        await git(['add', 'staged.txt'], repo)
        await writeFileAt(repo, 'unstaged.txt', 'v2 unstaged\n')
        await git(['reset', '-q', '--', 'unstaged.txt'], repo)
      },
      options: { mutationRewritesIndex: true, mutationWritesObjects: true }
    },
    {
      // O8 the turn edits .gitattributes / .gitignore, changing conversion and ignore rules.
      id: 'o8-git-semantics',
      setup: async (repo) => {
        await writeFileAt(repo, 'a.txt', 'plain\n')
        await writeFileAt(repo, 'nested/c.txt', 'plain\n')
        await commitAll(repo)
      },
      mutate: async (repo) => {
        await writeFileAt(repo, '.gitattributes', '*.txt text eol=crlf\n')
        await writeFileAt(repo, '.gitignore', '*.log\n')
        await writeFileAt(repo, 'a.txt', 'line1\nline2\n')
        await writeFileAt(repo, 'nested/c.txt', 'changed\n')
        await writeFileAt(repo, 'debug.log', 'ignored?\n')
      }
    }
  ]

  for (const scenario of scenarios) {
    it(`${scenario.id}: targeted equals full and leaves the real repository untouched`, async () => {
      await runScenarioPair(scenario)
    }, 90_000)
  }
})

describe('git snapshot oracle: filter drivers (known defect)', () => {
  it.fails('o9 the start-of-turn status must not execute a repository clean filter', async () => {
    for (const label of ['targeted', 'full'] as const) {
      const { root, repo } = await newRepoRoot(`o9-filter-${label}`)
      const marker = join(root, 'filter-ran')
      await writeFileAt(repo, 'a.txt', 'v1\n')
      await writeFileAt(repo, '.gitattributes', '* filter=marker\n')
      // The committed driver is inert; only after the commit does it gain a side effect.
      await git(['config', 'filter.marker.clean', 'cat'], repo)
      await git(['config', 'filter.marker.required', 'false'], repo)
      await stamp(repo, 'a.txt')
      await commitAll(repo)
      await git(['config', 'filter.marker.clean', `touch ${marker}`], repo)
      await git(['config', 'filter.marker.required', 'true'], repo)
      // An index older than its own entries is racy, so the next status must rehash the file
      // and therefore would run the configured clean driver.
      await utimes(join(repo, '.git', 'index'), new Date('2019-01-01T00:00:00.000Z'), new Date('2019-01-01T00:00:00.000Z'))
      const result = await runTurn(root, repo, { forceFull: label === 'full' }, async (cwd) => {
        await writeFileAt(cwd, 'a.txt', 'v2 with side effect\n')
      })
      expect(result.run.status).toBe('captured')
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 90_000)
})

describe('git snapshot oracle: nested repositories and submodules', () => {
  it('o10a nested repository: gitlink change matches the full path', async () => {
    const roots: Array<{ root: string; repo: string }> = []
    for (const label of ['targeted', 'full'] as const) {
      const fixture = await newRepoRoot(`o10a-nested-${label}`)
      const nested = join(fixture.repo, 'nested')
      await mkdir(nested)
      await git(['init', '-q', '--initial-branch=main'], nested)
      await writeFileAt(nested, 'inner.txt', 'one\n')
      await commitWithFixedDate(nested, 'inner one')
      await commitAll(fixture.repo)
      roots.push(fixture)
    }
    const mutate = async (repo: string) => {
      await writeFileAt(join(repo, 'nested'), 'inner.txt', 'two\n')
      await commitWithFixedDate(join(repo, 'nested'), 'inner two')
    }
    const targeted = await runTurn(roots[0].root, roots[0].repo, { forceFull: false }, mutate)
    const full = await runTurn(roots[1].root, roots[1].repo, { forceFull: true }, mutate)
    expectIndexAndObjectsUntouched(targeted, full)
    expectSameEvidence(targeted, full, roots[0].repo, roots[1].repo)
  }, 90_000)

  it('o10b submodule: gitlink change matches the full path', async () => {
    const roots: Array<{ root: string; repo: string; first: string }> = []
    for (const label of ['targeted', 'full'] as const) {
      const fixture = await newRepoRoot(`o10b-submodule-${label}`)
      const inner = join(fixture.root, 'inner')
      await mkdir(inner)
      await git(['init', '-q', '--initial-branch=main'], inner)
      await writeFileAt(inner, 'lib.txt', 'one\n')
      const first = await commitWithFixedDate(inner, 'inner one')
      await writeFileAt(inner, 'lib.txt', 'two\n')
      await commitWithFixedDate(inner, 'inner two')
      await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', './../inner', 'sub'], fixture.repo)
      await commitAll(fixture.repo)
      roots.push({ ...fixture, first })
    }
    const mutate = async (repo: string, index: number) => {
      await git(['checkout', '-q', roots[index].first], join(repo, 'sub'))
    }
    const targeted = await runTurn(roots[0].root, roots[0].repo, { forceFull: false }, (repo) => mutate(repo, 0))
    const full = await runTurn(roots[1].root, roots[1].repo, { forceFull: true }, (repo) => mutate(repo, 1))
    expectIndexAndObjectsUntouched(targeted, full)
    expectSameEvidence(targeted, full, roots[0].repo, roots[1].repo)
  }, 90_000)
})
