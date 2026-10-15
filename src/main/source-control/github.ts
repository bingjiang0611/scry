import {
  scCanMerge,
  type ScCheck,
  type ScInlineComment,
  type ScPr,
  type ScPrList
} from '../../shared/source-control'

interface GhUser {
  login: string
}
interface GhRepository {
  full_name: string
  default_branch: string
  permissions: { push: boolean }
  allow_merge_commit: boolean
  allow_squash_merge: boolean
  allow_rebase_merge: boolean
  parent?: { full_name: string }
}
interface GhPr {
  number: number
  title: string
  body: string | null
  html_url: string
  user: GhUser
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { sha: string; ref: string; repo: { full_name: string } }
  mergeable: boolean | null
  mergeable_state: string
  changed_files: number
}
interface GhFile {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}
interface GhComment {
  id: number
  user: GhUser
  body: string
  html_url: string
}
interface GhInlineComment extends GhComment {
  path: string
  line: number | null
  commit_id: string
}
interface GhReview {
  id: number
  user: GhUser
  body: string
  state: string
  commit_id: string
}
interface GhCheck {
  name: string
  status: string
  conclusion: string | null
}
interface GhStatus {
  context: string
  state: string
}

export class ScGithubError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean
  ) {
    super(message)
  }
}

export function validGithubRepository(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.length <= 220 &&
    !['.', '..'].includes(value.split('/')[1])
  )
}

export class ScGithub {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly transport: typeof fetch = fetch
  ) {}

  async connect(): Promise<GithubSession> {
    const token = (await this.token()).trim()
    if (!token) throw new Error('GitHub CLI 未提供登录凭证，请在终端运行 gh auth login --hostname github.com')
    const session = new GithubSession(token, this.transport)
    const user = await session.request<GhUser>('GET', '/user')
    if (typeof user.login !== 'string' || !user.login) throw new Error('GitHub 未返回有效账户身份')
    session.account = user.login
    return session
  }
}

export class GithubSession {
  account = ''
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch
  ) {}

  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const timer = AbortSignal.timeout(30_000)
    try {
      const response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        signal: timer,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'Scry-source-control'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      if (!response.ok) {
        const reset = response.headers.get('x-ratelimit-reset')
        const reason =
          response.status === 401
            ? 'GitHub 登录已失效'
            : response.status === 403 || response.status === 429
              ? `GitHub 拒绝访问或触发限流${reset ? `，限额重置 ${new Date(Number(reset) * 1000).toISOString()}` : ''}`
              : response.status === 404
                ? 'GitHub 仓库或 PR 不存在，或当前账户无权访问'
                : response.status === 409 || response.status === 422
                  ? 'GitHub 拒绝此次操作：版本、分支规则或提交内容不再满足要求'
                  : `GitHub HTTP ${response.status}`
        await response.body?.cancel()
        // A 5xx may follow a committed write. Do not classify it as a safe retry.
        throw new ScGithubError(reason, method !== 'GET' && response.status >= 500)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('GitHub 返回空响应')
      let size = 0
      const chunks: Uint8Array[] = []
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 8 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('GitHub 响应超过 8 MiB，不能当作完整数据')
        }
        chunks.push(result.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
    } catch (error) {
      if (error instanceof ScGithubError) throw error
      // Do not include transport errors/headers or a token-bearing request in renderer diagnostics.
      throw new ScGithubError('GitHub 请求中断或响应无法完整读取；写操作的结果需要核查', method !== 'GET')
    }
  }

  private repositoryPath(repository: string): string {
    if (!validGithubRepository(repository)) throw new Error('无效的 GitHub 仓库名称')
    return `/repos/${repository}`
  }

  metadata(repository: string): Promise<GhRepository> {
    return this.request('GET', this.repositoryPath(repository))
  }

  async list(repository: string): Promise<ScPrList> {
    const path = this.repositoryPath(repository)
    const [repo, rows] = await Promise.all([
      this.metadata(repository),
      this.request<GhPr[]>('GET', `${path}/pulls?state=open&per_page=100`)
    ])
    if (!Array.isArray(rows) || typeof repo.default_branch !== 'string')
      throw new Error('GitHub PR 列表格式不完整')
    return {
      account: this.account,
      repository,
      defaultBranch: repo.default_branch,
      complete: rows.length < 100,
      items: rows.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headBranch: pr.head.ref,
        headRepository: pr.head.repo?.full_name ?? null,
        baseBranch: pr.base.ref,
        url: `https://github.com/${repository}/pull/${pr.number}`
      }))
    }
  }

  async detail(repository: string, number: number): Promise<ScPr> {
    const path = this.repositoryPath(repository)
    const [pr, repo] = await Promise.all([
      this.request<GhPr>('GET', `${path}/pulls/${number}`),
      this.metadata(repository)
    ])
    if (
      !pr.head?.sha ||
      !pr.base?.sha ||
      typeof repo.permissions?.push !== 'boolean' ||
      !Number.isInteger(pr.changed_files)
    )
      throw new Error('GitHub 未返回完整的 PR 身份或权限')
    const [checkData, statusData, comments, reviews, inlineComments] = await Promise.all([
      this.request<{ total_count: number; check_runs: GhCheck[] }>(
        'GET',
        `${path}/commits/${pr.head.sha}/check-runs?per_page=100`
      ),
      this.request<{ total_count: number; statuses: GhStatus[] }>(
        'GET',
        `${path}/commits/${pr.head.sha}/status?per_page=100`
      ),
      this.request<GhComment[]>('GET', `${path}/issues/${number}/comments?per_page=100`),
      this.request<GhReview[]>('GET', `${path}/pulls/${number}/reviews?per_page=100`),
      this.request<GhInlineComment[]>('GET', `${path}/pulls/${number}/comments?per_page=100`)
    ])
    if (
      !Array.isArray(checkData.check_runs) ||
      !Array.isArray(statusData.statuses) ||
      !Array.isArray(comments) ||
      !Array.isArray(reviews) ||
      !Array.isArray(inlineComments)
    )
      throw new Error('GitHub 检查或审查数据不完整')
    const files: ScPr['files'] = []
    let patchBudget = 2 * 1024 * 1024
    for (let page = 1; page <= 10; page++) {
      const rows = await this.request<GhFile[]>(
        'GET',
        `${path}/pulls/${number}/files?per_page=100&page=${page}`
      )
      if (!Array.isArray(rows)) throw new Error('GitHub 文件列表格式错误')
      for (const file of rows) {
        const bytes = Buffer.from(file.patch ?? '')
        const displayed = bytes.subarray(0, Math.min(256 * 1024, patchBudget))
        patchBudget -= displayed.length
        let additions = 0
        let deletions = 0
        let inHunk = false
        for (const line of (file.patch ?? '').split('\n')) {
          if (line.startsWith('@@ ')) inHunk = true
          else if (inHunk && line.startsWith('+')) additions++
          else if (inHunk && line.startsWith('-')) deletions++
        }
        files.push({
          path: file.filename,
          ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: displayed.toString('utf8'),
          truncated:
            file.patch === undefined ||
            displayed.length !== bytes.length ||
            additions !== file.additions ||
            deletions !== file.deletions,
          binary: false
        })
      }
      if (rows.length < 100) break
    }
    // A moving head must not combine old metadata with new file line numbers.
    const after = await this.request<GhPr>('GET', `${path}/pulls/${number}`)
    if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha)
      throw new Error('PR 在读取期间发生变化，请刷新后重新审查')
    const checks: ScCheck[] = checkData.check_runs.map((check) => ({
      name: check.name,
      state:
        check.status !== 'completed'
          ? 'pending'
          : check.conclusion === 'success'
            ? 'passed'
            : check.conclusion === 'neutral' || check.conclusion === 'skipped'
              ? check.conclusion
              : ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(
                    check.conclusion ?? ''
                  )
                ? 'failed'
                : 'unknown'
    }))
    checks.push(
      ...statusData.statuses.map(
        (status): ScCheck => ({
          name: status.context,
          state:
            status.state === 'success'
              ? 'passed'
              : status.state === 'pending'
                ? 'pending'
                : ['error', 'failure'].includes(status.state)
                  ? 'failed'
                  : 'unknown'
        })
      )
    )
    return {
      repository,
      number,
      title: pr.title,
      body: pr.body ?? '',
      url: `https://github.com/${repository}/pull/${number}`,
      author: pr.user.login,
      account: this.account,
      state: pr.merged ? 'merged' : pr.state,
      draft: pr.draft,
      head: pr.head.sha,
      base: pr.base.sha,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      mergeState: pr.mergeable_state,
      mergeable: pr.mergeable,
      canWrite: repo.permissions.push,
      methods: [
        ...(repo.allow_merge_commit ? ['merge' as const] : []),
        ...(repo.allow_squash_merge ? ['squash' as const] : []),
        ...(repo.allow_rebase_merge ? ['rebase' as const] : [])
      ],
      checks,
      checksComplete:
        Number.isInteger(checkData.total_count) &&
        Number.isInteger(statusData.total_count) &&
        checkData.total_count <= checkData.check_runs.length &&
        statusData.total_count <= statusData.statuses.length,
      files,
      filesComplete: files.length === pr.changed_files,
      comments: [
        ...comments.map((comment) => ({
          id: comment.id,
          author: comment.user.login,
          body: comment.body,
          url: `https://github.com/${repository}/pull/${number}#issuecomment-${comment.id}`
        })),
        ...inlineComments.map((comment) => ({
          id: comment.id,
          author: comment.user.login,
          body: comment.body,
          path: comment.path,
          line: comment.line,
          head: comment.commit_id,
          url: `https://github.com/${repository}/pull/${number}#discussion_r${comment.id}`
        }))
      ],
      reviews: reviews.map((review) => ({
        id: review.id,
        author: review.user.login,
        body: review.body,
        state: review.state,
        head: review.commit_id
      })),
      activityComplete: comments.length < 100 && reviews.length < 100 && inlineComments.length < 100,
      observedAt: Date.now()
    }
  }

  async create(input: {
    repository: string
    headRepository: string
    headBranch: string
    baseBranch: string
    title: string
    body: string
    draft: boolean
  }): Promise<{ number: number; url: string }> {
    const path = this.repositoryPath(input.repository)
    const head = `${input.headRepository.split('/')[0]}:${input.headBranch}`
    const existing = await this.request<GhPr[]>(
      'GET',
      `${path}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.baseBranch)}&per_page=100`
    )
    if (!Array.isArray(existing)) throw new ScGithubError('无法确认既有 PR', false)
    if (existing.length)
      throw new ScGithubError('此 head/base 已有开放 PR，请从列表选择；不会重复创建', false)
    const result = await this.request<GhPr>('POST', `${path}/pulls`, {
      title: input.title,
      body: input.body,
      head,
      head_repo: input.headRepository.split('/')[1],
      base: input.baseBranch,
      draft: input.draft
    })
    if (!Number.isInteger(result.number))
      throw new ScGithubError('PR 可能已创建，但响应缺少身份，请核查 GitHub', true)
    return { number: result.number, url: `https://github.com/${input.repository}/pull/${result.number}` }
  }

  async review(
    pr: ScPr,
    input: { verdict: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string; comments: ScInlineComment[] }
  ): Promise<number> {
    if (input.verdict !== 'COMMENT' && pr.author === this.account)
      throw new ScGithubError('不能批准或请求修改自己的 PR', false)
    if (pr.state !== 'open') throw new ScGithubError('PR 已关闭，不能提交新审查', false)
    for (const comment of input.comments) {
      const file = pr.files.find((candidate) => candidate.path === comment.path)
      if (!file || file.truncated || !pr.filesComplete)
        throw new ScGithubError('行评论目标没有完整 diff 证据，请在 GitHub 审查', false)
      if (!validDiffLine(file.patch, comment.side, comment.line))
        throw new ScGithubError('行评论不属于当前版本的 diff，请重新定位', false)
    }
    const result = await this.request<{ id: number }>(
      'POST',
      `${this.repositoryPath(pr.repository)}/pulls/${pr.number}/reviews`,
      {
        event: input.verdict,
        body: input.body,
        commit_id: pr.head,
        comments: input.comments
      }
    )
    if (!Number.isInteger(result.id)) throw new ScGithubError('审查可能已提交，但未返回 review ID', true)
    return result.id
  }

  async merge(pr: ScPr, method: 'merge' | 'squash' | 'rebase'): Promise<string> {
    if (!scCanMerge(pr) || !pr.methods.includes(method))
      throw new ScGithubError('当前权限、分支规则、检查或版本尚不允许合并；不自动启用 auto-merge', false)
    const result = await this.request<{ merged: boolean; sha: string }>(
      'PUT',
      `${this.repositoryPath(pr.repository)}/pulls/${pr.number}/merge`,
      { sha: pr.head, merge_method: method }
    )
    if (!result.merged || !result.sha) throw new ScGithubError('GitHub 未确认合并成功，请核查 PR', true)
    return result.sha
  }
}

export function validDiffLine(patch: string, side: 'LEFT' | 'RIGHT', target: number): boolean {
  let left = 0
  let right = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      if (side === 'RIGHT' && right === target) return true
      right++
    } else if (line.startsWith('-')) {
      if (side === 'LEFT' && left === target) return true
      left++
    } else if (line.startsWith(' ')) {
      if ((side === 'LEFT' ? left : right) === target) return true
      left++
      right++
    }
  }
  return false
}
