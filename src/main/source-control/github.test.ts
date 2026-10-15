import { describe, expect, it, vi } from 'vitest'
import { ScGithub, ScGithubError, validDiffLine } from './github'
import { scCanMerge } from '../../shared/source-control'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
function fixture(
  options: {
    author?: string
    changingHead?: boolean
    incompleteChecks?: boolean
    writeFailure?: boolean
  } = {}
) {
  const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = []
  let reads = 0
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url: url.pathname + url.search, body })
    expect(url.origin).toBe('https://api.github.com')
    expect(init?.redirect).toBe('error')
    if (method !== 'GET' && options.writeFailure) throw new Error('connection lost with token SECRET')
    let data: unknown
    if (url.pathname === '/user') data = { login: 'reviewer' }
    else if (url.pathname.endsWith('/merge')) data = { merged: true, sha: 'c'.repeat(40) }
    else if (url.pathname.endsWith('/reviews') && method === 'POST') data = { id: 123 }
    else if (url.pathname.endsWith('/pulls') && method === 'POST') data = { number: 7 }
    else if (url.pathname.endsWith('/pulls/7')) {
      reads++
      data = {
        number: 7,
        title: 'PR',
        body: 'description',
        html_url: 'https://github.com/owner/repo/pull/7',
        user: { login: options.author ?? 'author' },
        state: 'open',
        merged: false,
        draft: false,
        head: {
          sha: options.changingHead && reads > 1 ? 'd'.repeat(40) : head,
          ref: 'feature',
          repo: { full_name: 'owner/repo' }
        },
        base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
        mergeable: true,
        mergeable_state: 'clean',
        changed_files: 1
      }
    } else if (url.pathname.endsWith('/check-runs'))
      data = {
        total_count: options.incompleteChecks ? 2 : 1,
        check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success' }]
      }
    else if (url.pathname.endsWith('/status')) data = { total_count: 0, statuses: [] }
    else if (url.pathname.endsWith('/files'))
      data = [
        {
          filename: 'file.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-old\n+new'
        }
      ]
    else if (url.pathname === '/repos/owner/repo')
      data = {
        full_name: 'owner/repo',
        default_branch: 'main',
        permissions: { push: true },
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false
      }
    else data = []
    return new Response(JSON.stringify(data), { status: 200 })
  })
  return { github: new ScGithub(async () => 'fixture-token', transport), requests, transport }
}

describe('GitHub explicit SHA-bound operations (no network)', () => {
  it('loads independent PR evidence, submits one batched review and binds merge to reviewed HEAD', async () => {
    const { github, requests } = fixture()
    const session = await github.connect()
    const pr = await session.detail('owner/repo', 7)
    expect(pr.filesComplete).toBe(true)
    expect(pr.checksComplete).toBe(true)
    expect(scCanMerge(pr)).toBe(true)
    expect(
      await session.review(pr, {
        verdict: 'COMMENT',
        body: 'review',
        comments: [{ path: 'file.txt', side: 'RIGHT', line: 1, body: 'inline' }]
      })
    ).toBe(123)
    expect(await session.merge(pr, 'squash')).toBe('c'.repeat(40))
    const writes = requests.filter((request) => request.method !== 'GET')
    expect(writes).toHaveLength(2)
    expect(writes[0].body).toMatchObject({
      commit_id: head,
      comments: [{ path: 'file.txt', side: 'RIGHT', line: 1, body: 'inline' }]
    })
    expect(writes[1].body).toEqual({ sha: head, merge_method: 'squash' })
  })

  it('does not combine a changed HEAD with old file-line evidence', async () => {
    const { github, requests } = fixture({ changingHead: true })
    const session = await github.connect()
    await expect(session.detail('owner/repo', 7)).rejects.toThrow('发生变化')
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('blocks self-approval, invalid lines and incomplete checks before POST/PUT', async () => {
    const { github, requests } = fixture({ author: 'reviewer', incompleteChecks: true })
    const session = await github.connect()
    const pr = await session.detail('owner/repo', 7)
    await expect(session.review(pr, { verdict: 'APPROVE', body: '', comments: [] })).rejects.toThrow('自己的')
    await expect(
      session.review(pr, {
        verdict: 'COMMENT',
        body: '',
        comments: [{ path: 'file.txt', side: 'RIGHT', line: 99, body: 'invalid' }]
      })
    ).rejects.toThrow('当前版本')
    await expect(session.merge(pr, 'squash')).rejects.toThrow('不自动启用')
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('retains a lost write response as unknown, does not retry, and never exposes token/errors', async () => {
    const { github, requests } = fixture({ writeFailure: true })
    const session = await github.connect()
    const pr = await session.detail('owner/repo', 7)
    try {
      await session.merge(pr, 'squash')
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ScGithubError)
      expect(error).toMatchObject({ uncertain: true })
      expect(String(error)).not.toContain('SECRET')
    }
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
  })

  it('preserves new-PR body, head/base identity and draft setting', async () => {
    const { github, requests } = fixture()
    const session = await github.connect()
    expect(
      await session.create({
        repository: 'owner/repo',
        headRepository: 'fork/repo',
        headBranch: 'feature',
        baseBranch: 'main',
        title: 'Title',
        body: 'Full description',
        draft: true
      })
    ).toEqual({ number: 7, url: 'https://github.com/owner/repo/pull/7' })
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      title: 'Title',
      body: 'Full description',
      head: 'fork:feature',
      head_repo: 'repo',
      base: 'main',
      draft: true
    })
  })
})

it('binds line comments to the correct old/new side', () => {
  const patch = '@@ -4,2 +4,2 @@\n keep\n-old\n+new'
  expect(validDiffLine(patch, 'LEFT', 5)).toBe(true)
  expect(validDiffLine(patch, 'RIGHT', 5)).toBe(true)
  expect(validDiffLine(patch, 'RIGHT', 6)).toBe(false)
})
