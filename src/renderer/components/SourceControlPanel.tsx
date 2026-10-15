import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  type ScDiff,
  type ScMutation,
  type ScOperation,
  type ScRead,
  type ScRepository
} from '@shared/source-control'
import { ModalFrame } from './Modals'
import { Patch } from './SourceControlPatch'
import { GithubPullRequestPanel } from './GithubPullRequestPanel'
import '../source-control.css'

const actionNames = {
  stage: '暂存',
  unstage: '取消暂存',
  commit: '提交',
  fetch: '获取远端',
  push: '推送',
  createPr: '创建 PR',
  review: '提交审查',
  merge: '合并 PR'
}
const statusNames = { running: '执行中', succeeded: '已确认', failed: '失败', unknown: '结果未知' }

export function SourceControlPanel({ cwd, active }: { cwd: string; active: boolean }) {
  const api = window.scry.sourceControl
  const [state, setState] = useState<ScRead<ScRepository> | null>(null)
  const [tab, setTab] = useState<'changes' | 'pr' | 'operations'>('changes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const epoch = useRef(0)
  const [operations, setOperations] = useState<ScOperation[]>([])
  const [selection, setSelection] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<ScRead<ScDiff> | null>(null)
  const [message, setMessage] = useState('')
  const [messageHead, setMessageHead] = useState<string | null>(null)
  const messageQueue = useRef(Promise.resolve())
  const messageVersion = useRef(0)
  const [remote, setRemote] = useState('')
  const [confirmation, setConfirmation] = useState<{
    title: string
    detail: string
    run: () => Promise<void>
  } | null>(null)
  const dialogId = useId()
  const repo = state?.status === 'available' ? state.data : null
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
    }
  }, [])
  const report = (caught: unknown): void => {
    if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
  }
  const refresh = useCallback(async (): Promise<void> => {
    const ticket = ++epoch.current
    const editingVersion = messageVersion.current
    const next = await api.read(cwd)
    if (!alive.current || ticket !== epoch.current) return
    setState(next)
    setDiff(null)
    setSelection(null)
    if (next.status === 'available') {
      await messageQueue.current
      const [latest, commitDraft] = await Promise.all([
        api.operations({ repositoryId: next.data.id }),
        api.loadCommitDraft({ repositoryId: next.data.id })
      ])
      if (!alive.current || ticket !== epoch.current) return
      if (editingVersion === messageVersion.current) {
        setMessage(commitDraft?.message ?? '')
        setMessageHead(commitDraft?.head ?? next.data.head)
      }
      setOperations((previous) => [
        ...latest,
        ...previous.filter((op) => op.status === 'unknown' && !latest.some((item) => item.id === op.id))
      ])
      setRemote((value) =>
        next.data.remotes.some((remote) => remote.name === value)
          ? value
          : next.data.remotes.length === 1
            ? next.data.remotes[0].name
            : ''
      )
    }
  }, [api, cwd])
  useEffect(() => {
    if (active) void refresh().catch(report)
    else {
      epoch.current++
      setConfirmation(null)
    }
  }, [active, refresh])

  async function execute(request: ScMutation): Promise<boolean> {
    if (busyRef.current || !active) return false
    busyRef.current = true
    setBusy(true)
    setError('')
    const operationId = crypto.randomUUID()
    let succeeded = false
    try {
      if (request.action === 'commit') await messageQueue.current
      const result = await api.mutate({ ...request, operationId })
      succeeded = result.status === 'succeeded'
      if (alive.current) {
        setOperations((previous) => [result, ...previous.filter((op) => op.id !== result.id)])
        if (result.status === 'succeeded' && request.action === 'commit') setMessage('')
        if (result.status !== 'succeeded') {
          setTab('operations')
          setError(result.message)
        }
      }
    } catch (caught) {
      if (alive.current) {
        setOperations((previous) => [
          {
            id: operationId,
            repositoryId: request.repositoryId,
            action: request.action,
            status: 'unknown',
            startedAt: Date.now(),
            message: '未收到执行确认；先查询日志，不重复发送。'
          },
          ...previous
        ])
        setTab('operations')
      }
      report(caught)
    } finally {
      try {
        await refresh()
      } catch (caught) {
        report(caught)
      }
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
    return succeeded
  }
  function updateMessage(value: string): void {
    if (!repo) return
    messageVersion.current++
    setMessage(value)
    setMessageHead(repo.head)
    messageQueue.current = messageQueue.current
      .then(() => api.saveCommitDraft({ repositoryId: repo.id, head: repo.head, message: value }))
      .catch(report)
  }
  function confirm(request: ScMutation, detail: string, afterSuccess?: () => Promise<void>): void {
    setConfirmation({
      title: `确认${actionNames[request.action]}`,
      detail,
      run: async () => {
        if (await execute(request)) await afterSuccess?.()
      }
    })
  }
  async function inspectFile(path: string, staged: boolean): Promise<void> {
    if (!repo) return
    const ticket = ++epoch.current
    setSelection({ path, staged })
    setDiff(null)
    try {
      const result = await api.diff({ repositoryId: repo.id, expectedRevision: repo.revision, path, staged })
      if (alive.current && ticket === epoch.current) setDiff(result)
    } catch (caught) {
      report(caught)
    }
  }
  const expected = repo ? { repositoryId: repo.id, expectedRevision: repo.revision } : null
  const staged = repo?.files.filter((file) => file.index !== '.' && !file.untracked) ?? []
  const working = repo?.files.filter((file) => file.untracked || file.worktree !== '.') ?? []
  const disabled =
    busy ||
    !active ||
    !!repo?.writeBlocker ||
    operations.some((op) => op.status === 'unknown' && !op.acknowledged)
  return (
    <section className="sc-panel" aria-label="源代码管理工作台" aria-busy={busy}>
      <header className="sc-header">
        <div>
          <strong>源代码管理</strong>
          <small>真实 Git 状态 · 不等于 Agent 文件足迹</small>
        </div>
        <button disabled={busy} onClick={() => void refresh().catch(report)}>
          刷新
        </button>
      </header>
      {error && (
        <div role="alert" className="sc-notice">
          {error}
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {!state && <p role="status">正在读取仓库…</p>}
      {state && state.status !== 'available' && (
        <div className="sc-empty">
          <h3>无法读取仓库</h3>
          <p>{state.reason}</p>
          <p>失败不是 clean；这里不会显示“没有变更”。</p>
        </div>
      )}
      {repo && (
        <>
          <div className="sc-identity">
            <strong>{repo.branch ?? 'Detached / unborn'}</strong>
            <code>{repo.head?.slice(0, 10) ?? '尚无提交'}</code>
            <small title={repo.root}>{repo.root}</small>
            <small>
              上游 {repo.upstream ?? '未设置'} · ↑{repo.ahead ?? '未知'} ↓{repo.behind ?? '未知'}
            </small>
          </div>
          <nav className="sc-tabs" aria-label="源代码管理页面">
            {(['changes', 'pr', 'operations'] as const).map((value) => (
              <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
                {value === 'changes'
                  ? `变更 ${repo.files.length}`
                  : value === 'pr'
                    ? 'Pull Request'
                    : '操作记录'}
              </button>
            ))}
          </nav>
          <div className="sc-scroll">
            {tab === 'changes' && expected && (
              <>
                {repo.writeBlocker && <p className="sc-notice">{repo.writeBlocker}</p>}
                {!repo.files.length && <p className="sc-empty">此快照没有工作区或暂存区变更。</p>}
                {[
                  { title: '暂存区 · 下一次提交的完整范围', files: staged, staged: true },
                  { title: '工作区 · 尚未提交到暂存区', files: working, staged: false }
                ].map((group) => (
                  <section className="sc-section" key={group.title}>
                    <h3>
                      {group.title} <span>{group.files.length}</span>
                    </h3>
                    {group.files.map((file) => (
                      <div className="sc-file" key={file.path}>
                        <span className="sc-file-status">{group.staged ? file.index : file.worktree}</span>
                        <button
                          className="sc-file-name"
                          title={file.path}
                          aria-pressed={selection?.path === file.path && selection.staged === group.staged}
                          onClick={() => void inspectFile(file.path, group.staged)}
                        >
                          {file.path}
                          {file.previousPath && <small>← {file.previousPath}</small>}
                        </button>
                        <button
                          disabled={disabled}
                          aria-label={`${group.staged ? '取消暂存' : '暂存'} ${file.path}`}
                          onClick={() => {
                            if (!group.staged && !file.untracked && file.index !== '.') {
                              confirm(
                                {
                                  ...expected,
                                  action: 'stage',
                                  paths: [file.path],
                                  allowStagedOverwrite: true
                                },
                                `${file.path} 已有部分暂存。继续会用此文件的完整工作区版本替换原有 index 选择；其他文件的暂存保持不变。`
                              )
                            } else {
                              void execute({
                                ...expected,
                                action: group.staged ? 'unstage' : 'stage',
                                paths: [file.path]
                              })
                            }
                          }}
                        >
                          {group.staged ? '−' : '+'}
                        </button>
                      </div>
                    ))}
                  </section>
                ))}
                {selection && (
                  <section className="sc-section">
                    <h3>
                      {selection.staged ? '暂存区' : '工作区'} / {selection.path}
                    </h3>
                    {!diff ? (
                      <p>读取差异…</p>
                    ) : diff.status === 'available' ? (
                      <Patch diff={diff.data} />
                    ) : (
                      <p role="alert">{diff.reason}</p>
                    )}
                  </section>
                )}
                <section className="sc-section">
                  <h3>提交已暂存内容</h3>
                  {message && messageHead !== repo.head && (
                    <p className="sc-notice">此消息恢复自旧 HEAD，请重新核对提交内容。</p>
                  )}
                  <label>
                    提交消息
                    <textarea
                      disabled={busy}
                      value={message}
                      maxLength={20_000}
                      placeholder="说明这次改动的目的"
                      onChange={(event) => updateMessage(event.target.value)}
                    />
                  </label>
                  <button
                    className="sc-primary"
                    disabled={disabled || !staged.length || !message.trim()}
                    onClick={() =>
                      confirm(
                        { ...expected, action: 'commit', message },
                        `提交完整暂存区，共 ${staged.length} 个文件。不会自动 git add 或清空现有 index。\n${staged.map((file) => file.path).join('\n')}\n\n${message}`
                      )
                    }
                  >
                    提交 {staged.length} 个已暂存文件
                  </button>
                </section>
                <section className="sc-section">
                  <h3>远端 · Git 身份与 GitHub API 登录独立</h3>
                  <label>
                    选择 remote
                    <select value={remote} onChange={(event) => setRemote(event.target.value)}>
                      <option value="" disabled>
                        请选择 remote
                      </option>
                      {repo.remotes.map((remote) => (
                        <option key={remote.name}>{remote.name}</option>
                      ))}
                    </select>
                  </label>
                  <code className="sc-wrap">
                    Fetch:{' '}
                    {repo.remotes.find((item) => item.name === remote)?.fetchUrls.join(', ') ?? '没有 remote'}
                    {'\n'}Push:{' '}
                    {repo.remotes.find((item) => item.name === remote)?.pushUrls.join(', ') ?? '没有 remote'}
                  </code>
                  <div className="sc-actions">
                    <button
                      disabled={disabled || !remote}
                      onClick={() =>
                        confirm(
                          { ...expected, action: 'fetch', remote },
                          `从 ${repo.remotes.find((item) => item.name === remote)?.fetchUrls.join(', ')} 获取分支，更新 refs/remotes/${remote}/*；不改工作区，不 prune。`
                        )
                      }
                    >
                      Fetch
                    </button>
                    <button
                      disabled={disabled || !remote || !repo.head || !repo.branch}
                      onClick={() =>
                        confirm(
                          { ...expected, action: 'push', remote },
                          `非强制推送 ${repo.head} → refs/heads/${repo.branch}\n目标：${repo.remotes.find((item) => item.name === remote)?.pushUrls.join(', ')}\n会直接更新所选分支，包括它是默认分支的情况；不会自动创建新分支或 PR。`
                        )
                      }
                    >
                      Push
                    </button>
                  </div>
                </section>
              </>
            )}
            <div hidden={tab !== 'pr'}>
              <GithubPullRequestPanel
                key={repo.id}
                repo={repo}
                active={active && tab === 'pr'}
                busy={busy}
                ask={confirm}
                report={report}
              />
            </div>
            {tab === 'operations' && (
              <section className="sc-section">
                <h3>操作证据 · 不自动重放</h3>
                {!operations.length && <p>本仓库没有本机操作记录。</p>}
                {operations.map((op) => (
                  <article className="sc-operation" key={op.id}>
                    <strong>
                      {actionNames[op.action]} · {statusNames[op.status]}
                      {op.acknowledged ? ' · 已人工核查' : ''}
                    </strong>
                    <small>{new Date(op.startedAt).toLocaleString()}</small>
                    <p className="sc-wrap">{op.message}</p>
                    {op.evidence?.sha && <code>{op.evidence.sha}</code>}
                    {op.evidence?.url && (
                      <a href={op.evidence.url} target="_blank" rel="noreferrer">
                        查看 PR
                      </a>
                    )}
                    {op.evidence?.reviewId && <small>review ID {op.evidence.reviewId}</small>}
                    {op.status === 'unknown' && (
                      <div className="sc-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void api
                              .reconcile({ repositoryId: repo.id, operationId: op.id })
                              .then(() => refresh())
                              .catch(report)
                          }
                        >
                          只读核查
                        </button>
                        {!op.acknowledged && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: '确认已人工核查',
                                detail:
                                  '结果仍然保留为 unknown。仅解除后续操作阻断，不重试、不回滚、不宣称成功。请先在 Git/GitHub 确认现场。',
                                run: async () => {
                                  await api.acknowledge({ repositoryId: repo.id, operationId: op.id })
                                  await refresh()
                                }
                              })
                            }
                          >
                            我已人工核查…
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </section>
            )}
          </div>
        </>
      )}
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
    </section>
  )
}
