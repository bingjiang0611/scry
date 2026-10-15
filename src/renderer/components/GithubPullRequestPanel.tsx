import { useEffect, useId, useRef, useState } from 'react'
import {
  githubRepositoryFromUrl,
  scCanMerge,
  type ScInlineComment,
  type ScMutation,
  type ScPr,
  type ScPrList,
  type ScRead,
  type ScRepository,
  type ScReviewDraft
} from '@shared/source-control'
import { ModalFrame } from './Modals'
import { Patch } from './SourceControlPatch'

export function GithubPullRequestPanel({
  repo,
  active,
  busy,
  ask,
  report
}: {
  repo: ScRepository
  active: boolean
  busy: boolean
  ask: (request: ScMutation, detail: string, afterSuccess?: () => Promise<void>) => void
  report: (error: unknown) => void
}) {
  const api = window.scry.sourceControl
  const alive = useRef(true)
  const epoch = useRef(0)
  const lineInput = useRef<HTMLTextAreaElement>(null)
  const github =
    repo.remotes
      .flatMap((remote) => [...remote.pushUrls, ...remote.fetchUrls].map(githubRepositoryFromUrl))
      .find(Boolean) ?? ''
  const [repository, setRepository] = useState(github)
  const [list, setList] = useState<ScRead<ScPrList> | null>(null)
  const [pr, setPr] = useState<ScPr | null>(null)
  const [loadingPr, setLoadingPr] = useState(false)
  const [draft, setDraft] = useState<ScReviewDraft | null>(null)
  const [draftState, setDraftState] = useState('')
  const draftQueue = useRef(Promise.resolve())
  const draftVersion = useRef(0)
  const [prFile, setPrFile] = useState('')
  const [lineTarget, setLineTarget] = useState<{ path: string; side: 'LEFT' | 'RIGHT'; line: number } | null>(
    null
  )
  const [lineBody, setLineBody] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [headRepository, setHeadRepository] = useState(github)
  const [createDraft, setCreateDraft] = useState(false)
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('squash')
  const [confirmation, setConfirmation] = useState<{
    title: string
    detail: string
    run: () => Promise<void>
  } | null>(null)
  const dialogId = useId()
  const staleDraft = !!(
    draft &&
    pr &&
    (draft.head !== pr.head || draft.base !== pr.base || draft.account !== pr.account)
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
    }
  }, [])
  useEffect(() => {
    if (lineTarget) lineInput.current?.focus()
  }, [lineTarget])
  useEffect(() => {
    if (!active) {
      epoch.current++
      setConfirmation(null)
    }
  }, [active])
  const expected = { repositoryId: repo.id, expectedRevision: repo.revision }
  function confirm(request: ScMutation, detail: string): void {
    ask(request, detail, async () => {
      if (request.action === 'review' || request.action === 'merge') await openPr(request.number)
      else if (request.action === 'createPr') await loadPrList()
    })
  }
  async function openPr(number: number): Promise<void> {
    const ticket = ++epoch.current
    setLoadingPr(true)
    report('')
    setLineTarget(null)
    setPr(null)
    setDraft(null)
    try {
      await draftQueue.current
      const ref = { repositoryId: repo.id, repository, number }
      const [result, saved] = await Promise.all([api.pullRequest(ref), api.loadDraft(ref)])
      if (!alive.current || ticket !== epoch.current) return
      if (result.status !== 'available') throw new Error(result.reason)
      setPr(result.data)
      setPrFile(result.data.files[0]?.path ?? '')
      setMethod(result.data.methods[0] ?? 'merge')
      setDraft(
        saved ?? {
          ...ref,
          account: result.data.account,
          head: result.data.head,
          base: result.data.base,
          body: '',
          verdict: 'COMMENT',
          comments: []
        }
      )
      setDraftState(saved ? '草稿已恢复' : '仅保存在本机，提交后才发送 GitHub')
    } catch (caught) {
      report(caught)
    } finally {
      if (alive.current) setLoadingPr(false)
    }
  }
  async function loadPrList(): Promise<void> {
    setLoadingPr(true)
    report('')
    setPr(null)
    setDraft(null)
    try {
      const result = await api.pullRequests({ repositoryId: repo.id, repository })
      if (!alive.current) return
      setList(result)
      if (result.status === 'available') setBaseBranch(result.data.defaultBranch)
    } catch (caught) {
      report(caught)
    } finally {
      if (alive.current) setLoadingPr(false)
    }
  }
  function updateDraft(next: ScReviewDraft): void {
    const version = ++draftVersion.current
    setDraft(next)
    setDraftState('保存中…')
    draftQueue.current = draftQueue.current
      .then(() => api.saveDraft(next))
      .then(
        () => {
          if (alive.current && version === draftVersion.current) setDraftState('草稿已保存')
        },
        (caught) => {
          report(caught)
          if (alive.current && version === draftVersion.current)
            setDraftState('保存失败，请保留文本并重新编辑以保存')
        }
      )
  }
  const selectedPrFile = pr?.files.find((file) => file.path === prFile)
  const prExpected =
    pr && repo
      ? {
          repositoryId: repo.id,
          repository: pr.repository,
          number: pr.number,
          account: pr.account,
          head: pr.head,
          base: pr.base
        }
      : null

  return (
    <>
      <fieldset className="sc-form" disabled={busy || loadingPr} aria-label="GitHub Pull Request">
        <section className="sc-section">
          <h3>GitHub.com</h3>
          <p className="sc-muted">
            使用本机 gh 当前账户。第一次点击读取才访问 GitHub。仅绑定当前仓库的 remote 或其 fork 上游。
          </p>
          <label>
            目标仓库
            <input
              value={repository}
              placeholder="owner/repository"
              disabled={loadingPr || busy}
              onChange={(event) => {
                setRepository(event.target.value)
                setList(null)
                setPr(null)
                setDraft(null)
              }}
            />
          </label>
          <button disabled={loadingPr || busy || !repository} onClick={() => void loadPrList()}>
            读取开放 PR
          </button>
        </section>
        {list?.status !== 'available' && list && (
          <p role="alert" className="sc-notice">
            {list.reason}
          </p>
        )}
        {list?.status === 'available' && (
          <>
            <p className="sc-muted">
              API 账户：{list.data.account} ·{' '}
              {list.data.complete ? '列表完整' : '只显示前 100 个，请在 GitHub 查看更多'}
            </p>
            <div className="sc-pr-list">
              {list.data.items.map((item) => (
                <button
                  key={item.number}
                  disabled={busy || loadingPr}
                  onClick={() => void openPr(item.number)}
                >
                  <strong>
                    #{item.number} {item.title}
                  </strong>
                  <small>
                    {item.headRepository}:{item.headBranch} → {item.baseBranch}
                  </small>
                </button>
              ))}
            </div>
            <details className="sc-section">
              <summary>创建 Pull Request</summary>
              <label>
                源仓库
                <input value={headRepository} onChange={(event) => setHeadRepository(event.target.value)} />
              </label>
              <p>源分支：{repo.branch ?? '无分支'} · 必须先手动推送到 GitHub</p>
              <label>
                目标分支
                <input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
              </label>
              <label>
                标题
                <input value={title} maxLength={256} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label>
                描述
                <textarea value={body} maxLength={60_000} onChange={(event) => setBody(event.target.value)} />
              </label>
              <label className="sc-check">
                <input
                  type="checkbox"
                  checked={createDraft}
                  onChange={(event) => setCreateDraft(event.target.checked)}
                />
                创建为 Draft
              </label>
              <button
                disabled={busy || loadingPr || !title.trim() || !baseBranch || !repo.branch || !expected}
                onClick={() =>
                  expected &&
                  list.status === 'available' &&
                  confirm(
                    {
                      ...expected,
                      action: 'createPr',
                      repository,
                      account: list.data.account,
                      headRepository,
                      headBranch: repo.branch!,
                      baseBranch,
                      title,
                      body,
                      draft: createDraft
                    },
                    `${headRepository}:${repo.branch} → ${repository}:${baseBranch}\n账户：${list.data.account}\n${createDraft ? 'Draft' : 'Ready for review'}\n${title}\n\n${body}`
                  )
                }
              >
                创建 PR…
              </button>
            </details>
          </>
        )}
        {loadingPr && <p role="status">正在读取 GitHub 证据…</p>}
        {pr && prExpected && (
          <>
            <section className="sc-section">
              <h3>
                #{pr.number} {pr.title}
              </h3>
              <a href={pr.url} target="_blank" rel="noreferrer">
                在 GitHub 查看
              </a>
              <p>
                {pr.state} {pr.draft ? '· Draft' : ''} · {pr.author}
              </p>
              <p>
                {pr.headBranch} → {pr.baseBranch}
              </p>
              <code>
                HEAD {pr.head.slice(0, 10)} / base {pr.base.slice(0, 10)}
              </code>
              <p className="sc-wrap">{pr.body}</p>
              <button disabled={loadingPr || busy} onClick={() => void openPr(pr.number)}>
                刷新 PR 与版本
              </button>
              <h4>检查与合并条件</h4>
              <p>
                {pr.mergeState} · {pr.canWrite ? '有写入权限' : '无写入权限'} ·{' '}
                {pr.checksComplete ? '检查读取完整' : '检查不完整，禁止合并'}
              </p>
              {!pr.checks.length && <p>没有返回 check，不等于自动满足分支规则。</p>}
              {pr.checks.map((check, index) => (
                <p key={index}>
                  {check.state === 'passed' ? '✓' : check.state === 'pending' ? '◷' : '!'} {check.name} ·{' '}
                  {check.state}
                </p>
              ))}
            </section>
            <section className="sc-section">
              <h3>PR 差异 · {pr.filesComplete ? `${pr.files.length} 个文件` : '文件列表不完整'}</h3>
              <select
                aria-label="PR 文件"
                value={prFile}
                onChange={(event) => {
                  setPrFile(event.target.value)
                  setLineTarget(null)
                }}
              >
                {pr.files.map((file) => (
                  <option key={file.path}>{file.path}</option>
                ))}
              </select>
              {selectedPrFile && (
                <Patch
                  diff={selectedPrFile}
                  onLine={
                    !staleDraft && pr.filesComplete && !loadingPr
                      ? (side, line) => {
                          setLineTarget({ path: prFile, side, line })
                          setLineBody('')
                        }
                      : undefined
                  }
                />
              )}
              {lineTarget && (
                <div className="sc-line-comment">
                  <strong>
                    {lineTarget.path} · {lineTarget.side} {lineTarget.line}
                  </strong>
                  <label>
                    行评论草稿
                    <textarea
                      ref={lineInput}
                      value={lineBody}
                      maxLength={10_000}
                      onChange={(event) => setLineBody(event.target.value)}
                    />
                  </label>
                  <button
                    disabled={!lineBody.trim() || !draft || staleDraft}
                    onClick={() => {
                      if (draft)
                        updateDraft({
                          ...draft,
                          comments: [...draft.comments, { ...lineTarget, body: lineBody } as ScInlineComment]
                        })
                      setLineTarget(null)
                    }}
                  >
                    加入本机审查草稿
                  </button>
                </div>
              )}
            </section>
            {draft && (
              <section className="sc-section">
                <h3>审查草稿</h3>
                {staleDraft && (
                  <div className="sc-notice">
                    草稿绑定旧 HEAD/base 或其他账户。禁止自动重定位或提交。
                    <button
                      onClick={() =>
                        setConfirmation({
                          title: '丢弃旧审查草稿？',
                          detail: '旧正文和行评论将被清除；不会发送到 GitHub。请先复制需要保留的内容。',
                          run: async () =>
                            updateDraft({ ...prExpected, body: '', verdict: 'COMMENT', comments: [] })
                        })
                      }
                    >
                      丢弃旧草稿并重新审查
                    </button>
                  </div>
                )}
                <label>
                  审查正文
                  <textarea
                    disabled={staleDraft}
                    value={draft.body}
                    maxLength={60_000}
                    onChange={(event) => updateDraft({ ...draft, body: event.target.value })}
                  />
                </label>
                <label>
                  审查结论
                  <select
                    disabled={staleDraft}
                    value={draft.verdict}
                    onChange={(event) =>
                      updateDraft({
                        ...draft,
                        verdict: event.target.value as ScReviewDraft['verdict']
                      })
                    }
                  >
                    <option value="COMMENT">评论</option>
                    <option value="APPROVE" disabled={pr.author === pr.account}>
                      批准
                    </option>
                    <option value="REQUEST_CHANGES" disabled={pr.author === pr.account}>
                      请求修改
                    </option>
                  </select>
                </label>
                {draft.comments.map((comment, index) => (
                  <div className="sc-draft-comment" key={index}>
                    <strong>
                      {comment.path}:{comment.line} ({comment.side})
                    </strong>
                    <p>{comment.body}</p>
                    <button
                      disabled={staleDraft}
                      onClick={() =>
                        updateDraft({
                          ...draft,
                          comments: draft.comments.filter((_, i) => i !== index)
                        })
                      }
                    >
                      移除草稿评论
                    </button>
                  </div>
                ))}
                <small role="status">{draftState}</small>
                <button
                  disabled={
                    busy ||
                    loadingPr ||
                    staleDraft ||
                    draftState.includes('保存中') ||
                    draftState.includes('失败') ||
                    pr.state !== 'open' ||
                    (draft.verdict === 'COMMENT' && !draft.body.trim() && !draft.comments.length)
                  }
                  onClick={() =>
                    confirm(
                      { ...draft, action: 'review' },
                      `向 ${pr.repository}#${pr.number} 提交 ${draft.verdict}\n账户：${pr.account}\nHEAD：${draft.head}\n行评论：${draft.comments.length} 条\n\n${draft.body}`
                    )
                  }
                >
                  提交审查…
                </button>
              </section>
            )}
            <section className="sc-section">
              <h3>合并</h3>
              <label>
                合并方式
                <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                  {pr.methods.map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
              </label>
              <p className="sc-muted">
                仅合并已审查 SHA。不自动开启 auto-merge，不删除源分支。点击后 main 会重新核实权限和检查。
              </p>
              <button
                className="sc-primary"
                disabled={busy || loadingPr || !scCanMerge(pr)}
                onClick={() =>
                  confirm(
                    { ...prExpected, action: 'merge', method },
                    `${method} 合并 ${pr.repository}#${pr.number}\nHEAD：${pr.head}\n目标：${pr.baseBranch}\n账户：${pr.account}\n这是远端写入，不会自动撤销。`
                  )
                }
              >
                合并 PR…
              </button>
            </section>
            <details className="sc-section">
              <summary>讨论与审查证据</summary>
              {!pr.activityComplete && <p>仅前 100 条，完整讨论请在 GitHub 查看。</p>}
              {pr.comments.map((comment) => (
                <article key={comment.url}>
                  <strong>{comment.author}</strong>
                  {comment.path && (
                    <small>
                      {comment.path}:{comment.line ?? '未提供当前行号'} · HEAD {comment.head?.slice(0, 10)}
                    </small>
                  )}
                  <p className="sc-wrap">{comment.body}</p>
                </article>
              ))}
              {pr.reviews.map((review) => (
                <article key={review.id}>
                  <strong>
                    {review.author} · {review.state}
                  </strong>
                  <small>HEAD {review.head.slice(0, 10)}</small>
                  <p className="sc-wrap">{review.body}</p>
                </article>
              ))}
            </details>
          </>
        )}
      </fieldset>
      {confirmation && (
        <ModalFrame labelledBy={dialogId} onClose={() => setConfirmation(null)}>
          <h2 id={dialogId}>{confirmation.title}</h2>
          <pre className="sc-confirm-detail">{confirmation.detail}</pre>
          <div className="sc-actions">
            <button onClick={() => setConfirmation(null)}>取消</button>
            <button
              className="sc-primary"
              onClick={() => {
                const action = confirmation.run
                setConfirmation(null)
                void action().catch(report)
              }}
            >
              确认执行
            </button>
          </div>
        </ModalFrame>
      )}
    </>
  )
}
