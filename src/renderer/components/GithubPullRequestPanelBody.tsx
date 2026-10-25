import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ScExpected, ScInlineComment, ScMutation, ScPr, ScPrList, ScRead, ScRepository, ScReviewDraft } from '@shared/source-control'
import { ModalFrame, requestModalClose } from './Modals'
import { Patch } from './SourceControlPatch'

type Confirmation = { title: string; detail: string; run: () => Promise<void> }

export function GithubPullRequestPanelBody({
  repo, busy, loadingPr, repository, repositories, github, list, pr, draft, draftState, prFile, selectedPrFile, lineInput, lineTarget, lineBody, title, body, baseBranch, headRepository, createDraft, method, confirmation, dialogId, prExpected, expected, staleDraft, scCanMerge, report, setRepository, setList, setPr, setDraft, setPrFile, setLineTarget, setLineBody, setTitle, setBody, setBaseBranch, setHeadRepository, setCreateDraft, setMethod, setConfirmation, openPr, loadPrList, updateDraft, confirm
}: {
  repo: ScRepository; busy: boolean; loadingPr: boolean; repository: string; repositories: string[]; github: string
  list: ScRead<ScPrList> | null; pr: ScPr | null; draft: ScReviewDraft | null; draftState: string; prFile: string; selectedPrFile?: ScPr['files'][number]
  lineInput: MutableRefObject<HTMLTextAreaElement | null>; lineTarget: { path: string; side: 'LEFT' | 'RIGHT'; line: number } | null; lineBody: string
  title: string; body: string; baseBranch: string; headRepository: string; createDraft: boolean; method: 'merge' | 'squash' | 'rebase'; confirmation: Confirmation | null; dialogId: string
  prExpected: { repositoryId: string; repository: string; number: number; account: string; head: string; base: string } | null
  expected: ScExpected; staleDraft: boolean; scCanMerge: (pr: ScPr) => boolean
  report: (error: unknown) => void
  setRepository: (value: string) => void; setList: Dispatch<SetStateAction<ScRead<ScPrList> | null>>; setPr: Dispatch<SetStateAction<ScPr | null>>; setDraft: Dispatch<SetStateAction<ScReviewDraft | null>>; setPrFile: (value: string) => void; setLineTarget: Dispatch<SetStateAction<{ path: string; side: 'LEFT' | 'RIGHT'; line: number } | null>>; setLineBody: (value: string) => void; setTitle: (value: string) => void; setBody: (value: string) => void; setBaseBranch: (value: string) => void; setHeadRepository: (value: string) => void; setCreateDraft: (value: boolean) => void; setMethod: (value: 'merge' | 'squash' | 'rebase') => void; setConfirmation: Dispatch<SetStateAction<Confirmation | null>>
  openPr: (number: number) => Promise<void>; loadPrList: () => Promise<void>; updateDraft: (next: ScReviewDraft) => void; confirm: (request: ScMutation, detail: string) => void
}) {
  return (
    <>
      <fieldset className="sc-form" disabled={busy || loadingPr} aria-label="GitHub Pull Request">
        <section className="sc-section">
          <h3>{repository || '选择 GitHub 目标仓库'}</h3>
          <p className="sc-muted">当前分支：{repo.branch ?? 'Detached HEAD'}。点击读取才访问 GitHub，使用本机 gh 当前账户。</p>
          <details open={!github}>
            <summary>{github ? '切换目标仓库 / fork 上游' : repositories.length > 1 ? '检测到多个仓库，请选择目标' : 'remote 无法识别，请填写已绑定的 GitHub 仓库'}</summary>
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
          </details>
          <button className="sc-primary" disabled={loadingPr || busy || !repository} onClick={() => void loadPrList()}>
            读取当前分支 PR
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
            <details className="sc-section" open={!pr}><summary>开放 PR 列表（{list.data.items.length}）</summary>
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
            {!list.data.items.length && <p className="sc-muted">{list.data.complete ? '没有开放的 PR。' : '已读取范围内没有开放 PR，列表不完整。'}</p>}
            </details>
            <details className="sc-section" open={!pr}>
              <summary>创建 Pull Request</summary>
              <label>
                源仓库
                <input value={headRepository} onChange={(event) => setHeadRepository(event.target.value)} />
              </label>
              <p>源分支：{repo.branch ?? '无分支'} · 必须先推送，本操作不会夹带自动推送。</p>
              {headRepository.toLowerCase() === repository.toLowerCase() && repo.branch === baseBranch && <p className="sc-notice">当前源分支与目标相同。请先在终端创建功能分支，不能创建同分支 PR。</p>}
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
                disabled={busy || loadingPr || !!repo.writeBlocker || !title.trim() || !baseBranch || !repo.branch || !repo.head || !expected || (headRepository.toLowerCase() === repository.toLowerCase() && repo.branch === baseBranch)}
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
            <button onClick={() => requestModalClose()}>取消</button>
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
