import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ScDiff, ScMutation, ScOperation, ScRead, ScRepository } from '@shared/source-control'
import { basename } from '../format'
import { commitFiles, isStaged, nextGitAction, type ScDelivery } from '../source-control-workflow'
import { ModalFrame } from './Modals'
import { Patch } from './SourceControlPatch'
import { GithubPullRequestPanel } from './GithubPullRequestPanel'
import { defaultSourceControlApi, type SourceControlApi } from '../workbench-api'
import { SourceControlCommitDialog } from './SourceControlCommitDialog'
import '../source-control.css'

import { SourceControlOperations } from './SourceControlOperations'
import { SourceControlFileRow } from './SourceControlFileRow'
import { SourceControlTransportDialog } from './SourceControlTransportDialog'
import { SourceControlRepositoryDialog } from './SourceControlRepositoryDialog'
import {
  sourceControlActionNames as actionNames, sourceControlStatusNames as statusNames,
  sourceControlOperationCopy, sourceControlFileCopy
} from '../constants/source-control-copy'

export function SourceControlPanel({ cwd, active, api: injectedApi }: { cwd: string; active: boolean; api?: SourceControlApi }) {
  const api = useMemo(() => injectedApi ?? defaultSourceControlApi, [injectedApi])
  const [state, setState] = useState<ScRead<ScRepository> | null>(null)
  const [tab, setTab] = useState<'changes' | 'pr' | 'operations'>('changes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [runningAction, setRunningAction] = useState<ScMutation['action'] | null>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const epoch = useRef(0)
  const currentCwd = useRef(cwd)
  currentCwd.current = cwd
  const diffEpoch = useRef(0)
  const backToFiles = useRef<HTMLButtonElement>(null)
  const [operations, setOperations] = useState<ScOperation[]>([])
  const [selection, setSelection] = useState<{ path: string; staged: boolean } | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [diff, setDiff] = useState<ScRead<ScDiff> | null>(null)
  const [message, setMessage] = useState('')
  const [messageHead, setMessageHead] = useState<string | null>(null)
  const messageQueue = useRef(Promise.resolve())
  const messageVersion = useRef(0)
  const [remote, setRemote] = useState('')
  const [delivery, setDelivery] = useState<ScDelivery | null>(null)
  const [commitTitle, setCommitTitle] = useState('')
  const [commitOpen, setCommitOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [transport, setTransport] = useState<'push' | 'fetch' | null>(null)
  const [confirmation, setConfirmation] = useState<{
    title: string
    detail: string
    run: () => Promise<void>
    blocker?: string | null
  } | null>(null)
  const dialogId = useId()
  const repo = state?.status === 'available' ? state.data : null
  const report = (caught: unknown): void => {
    if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
      diffEpoch.current++
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    const ticket = ++epoch.current
    const editingVersion = messageVersion.current
    const next = await api.read(cwd)
    if (!alive.current || ticket !== epoch.current) return
    diffEpoch.current++
    setState(next)
    setSelected([])
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
        ...previous.filter((op) => op.repositoryId === next.data.id && op.status === 'unknown' && !latest.some((item) => item.id === op.id))
      ])
      setRemote((value) => next.data.remotes.some((item) => item.name === value)
        ? value : next.data.remotes.length === 1 ? next.data.remotes[0].name : '')
    }
  }, [api, cwd])
  useEffect(() => {
    setState(null)
    setOperations([])
    setMessage('')
    setDelivery(null)
    setCommitTitle('')
    setSelected([])
    setCommitOpen(false)
    setConfirmation(null)
    setTransport(null)
    setTab('changes')
  }, [cwd])
  useEffect(() => {
    if (active) void refresh().catch(report)
    else {
      epoch.current++
      diffEpoch.current++
      setConfirmation(null)
      setCommitOpen(false)
      setTransport(null)
      setActionsOpen(false)
      setDetailsOpen(false)
    }
  }, [active, refresh])
  useEffect(() => {
    if (selection && backToFiles.current?.offsetParent) backToFiles.current.focus()
  }, [selection?.path])

  async function execute(request: ScMutation): Promise<boolean> {
    if (busyRef.current || !active) return false
    busyRef.current = true
    setBusy(true)
    setRunningAction(request.action)
    setError('')
    const operationId = crypto.randomUUID()
    let succeeded = false
    try {
      if (request.action === 'commit') await messageQueue.current
      const result = await api.mutate({ ...request, operationId })
      succeeded = result.status === 'succeeded'
      if (alive.current && currentCwd.current === cwd) {
        setOperations((previous) => [result, ...previous.filter((op) => op.id !== result.id)])
        if (result.status === 'succeeded') {
          if (request.action === 'commit') {
            setMessage('')
            setCommitTitle(request.message.trim().split('\n')[0])
          }
          if ((request.action === 'commit' || request.action === 'push') && result.evidence?.sha && repo) {
            setDelivery({ repositoryId: repo.id, branch: repo.branch, head: result.evidence.sha,
              next: request.action === 'commit' ? 'push' : 'pr' })
          }
        } else {
          setTab('operations')
          setError(result.message)
        }
      }
    } catch (caught) {
      if (alive.current && currentCwd.current === cwd) {
        setOperations((previous) => [{
          id: operationId, repositoryId: request.repositoryId, action: request.action,
          status: 'unknown', startedAt: Date.now(), message: '未收到执行确认；先查询日志，不重复发送。'
        }, ...previous])
        setTab('operations')
      }
      report(caught)
    } finally {
      try { if (currentCwd.current === cwd) await refresh() } catch (caught) { report(caught) }
      busyRef.current = false
      if (alive.current) {
        setBusy(false)
        setRunningAction(null)
      }
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
    const gitAction = request.action === 'stage' || request.action === 'unstage' || request.action === 'commit' || request.action === 'push' || request.action === 'fetch'
      ? request.action : null
    setConfirmation({
      title: `确认${actionNames[request.action]}`, detail,
      blocker: repo?.writeBlocker ?? (gitAction ? repo?.actionBlockers[gitAction] : null),
      run: async () => { if (await execute(request)) await afterSuccess?.() }
    })
  }
  function toggleFile(path: string): void {
    setSelected((previous) => previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path])
  }
  async function inspectFile(path: string, staged: boolean): Promise<void> {
    if (!repo) return
    const ticket = ++diffEpoch.current
    setSelection({ path, staged })
    setDiff(null)
    try {
      const result = await api.diff({ repositoryId: repo.id, expectedRevision: repo.revision, path, staged })
      if (alive.current && ticket === diffEpoch.current) setDiff(result)
    } catch (caught) { report(caught) }
  }
  const expected = repo ? { repositoryId: repo.id, expectedRevision: repo.revision } : null
  const unknown = operations.some((op) => op.status === 'unknown' && !op.acknowledged)
  const disabled = busy || !active || !!repo?.writeBlocker || unknown
  const primary = repo ? nextGitAction(repo, delivery, unknown) : null
  const scope = repo ? commitFiles(repo, selected) : []
  const selectedFile = repo?.files.find((file) => file.path === selection?.path)
  const pushed = repo && delivery?.repositoryId === repo.id && delivery.branch === repo.branch && delivery.head === repo.head && delivery.next === 'pr'
  const transportBlocker = transport && repo ? repo.writeBlocker ?? repo.actionBlockers[transport] : null
  const destination = repo?.remotes.find((item) => item.name === remote)
  const primaryClick = (): void => {
    if (primary?.action === 'commit') setCommitOpen(true)
    else if (primary?.action === 'push') setTransport('push')
    else if (primary?.action === 'pr') setTab('pr')
    else setTab('operations')
  }
  return (
    <section className="sc-panel" aria-label="源代码管理工作台" aria-busy={busy}>
      <header className="sc-header">
        <div><strong>{repo ? basename(repo.root) : '源代码管理'}</strong><span className="sc-branch"> / {repo?.branch ?? 'Detached / unborn'}</span>
          {repo && <small>{repo.upstream ? `上游 ${repo.upstream}` : '尚未设置上游'} · {pushed ? '本次推送已确认' : `↑${repo.ahead ?? '未知'} ↓${repo.behind ?? '未知'}`}</small>}
        </div>
        <div className="sc-header-actions"><button disabled={busy} onClick={() => setDetailsOpen(true)}>详情</button>
          <button disabled={busy} title="刷新后需要重新选择工作区提交范围" onClick={() => void refresh().catch(report)}>刷新</button></div>
      </header>
      {error && <div role="alert" className="sc-notice sc-error">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
      {!state && <p role="status" className="sc-empty">正在读取仓库…</p>}
      {state && state.status !== 'available' && <div className="sc-empty"><h3>无法读取仓库</h3><p>{state.reason}</p><p>读取失败不代表没有变更。</p></div>}
      {repo && primary && expected && <>
        <nav className="sc-tabs" aria-label="源代码管理页面">
          {(['changes', 'pr', 'operations'] as const).map((value) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
            {value === 'changes' ? `变更 ${repo.files.length}` : value === 'pr' ? 'Pull Request' : '操作记录'}
          </button>)}
        </nav>
        {repo.writeBlocker && <p className="sc-notice sc-global-blocker" role="status">{repo.writeBlocker}</p>}
        {!repo.writeBlocker && repo.actionBlockers.push && <div className="sc-inline-notice"><span>推送受限，本地提交按自身条件检查。</span><button onClick={() => setTransport('push')}>查看原因</button></div>}
        <div className="sc-workspace-shell" hidden={tab !== 'changes'}>
          <div className={`sc-workspace${selection ? ' has-selection' : ''}`}>
            <section className="sc-file-pane" aria-label="本次提交范围">
              <header><strong>文件</strong><span>已选 {scope.length} / {repo.files.length}</span></header>
              <p className="sc-selection-help">勾选要提交的文件，点击文件查看差异</p>
              {!repo.files.length && <p className="sc-empty">没有未提交的改动。</p>}
              {repo.files.map(file => <SourceControlFileRow key={file.path} file={file} buttonId={`${dialogId}-${file.path}`}
                selected={selection?.path === file.path} included={isStaged(file) || selected.includes(file.path)}
                busy={busy} unstageDisabled={disabled || !!repo.actionBlockers.unstage}
                onToggle={() => toggleFile(file.path)} onInspect={() => void inspectFile(file.path, isStaged(file))}
                onUnstage={() => confirm({ ...expected, action: 'unstage', paths: [file.path] }, sourceControlFileCopy.unstageDetail(file.path))} />)}
              <p className="sc-scope-note">勾选只确定提交范围。确认提交时才暂存所选文件；已有暂存内容始终纳入，未选工作区改动保留。</p>
            </section>
            <section className="sc-diff-pane" aria-label="文件差异">
              <header><button ref={backToFiles} className="sc-back-files" onClick={() => {
                diffEpoch.current++
                const path = selection?.path
                setSelection(null)
                requestAnimationFrame(() => document.getElementById(`${dialogId}-${path}`)?.focus())
              }}>← 文件</button><div><strong>{selection ? basename(selection.path) : '选择文件查看差异'}</strong>
                <small>{selection?.path}</small></div></header>
              {selection && selectedFile ? <div className="sc-diff-scroll">
                {isStaged(selectedFile) && selectedFile.worktree !== '.' && <div className="sc-diff-switch">
                  <button aria-pressed={selection.staged} onClick={() => void inspectFile(selection.path, true)}>暂存内容</button>
                  <button aria-pressed={!selection.staged} onClick={() => void inspectFile(selection.path, false)}>未暂存余量</button>
                  <button disabled={disabled || !!repo.actionBlockers.stage} onClick={() => confirm({ ...expected, action: 'stage', paths: [selection.path], allowStagedOverwrite: true }, `${selection.path} 已有部分暂存。继续会用完整工作区版本替换此文件的 index 选择；其他文件的暂存保持不变。`)}>暂存整个文件…</button>
                </div>}
                {!diff ? <p role="status">读取差异…</p> : diff.status === 'available' ? <Patch diff={diff.data} /> : <p role="alert">{diff.reason}</p>}
              </div> : <p className="sc-empty">点击文件名，检查实际 Git 差异。</p>}
            </section>
          </div>
        </div>
        <div className="sc-scroll" hidden={tab !== 'pr'}>
          <GithubPullRequestPanel key={`${repo.id}:${repo.branch}`} repo={repo} active={active && tab === 'pr'} busy={busy} suggestedTitle={delivery?.head === repo.head ? commitTitle : ''} ask={confirm} report={report} api={api} />
        </div>
        {tab === 'operations' && <SourceControlOperations operations={operations} busy={busy}
          onReconcile={operationId => void api.reconcile({ repositoryId: repo.id, operationId }).then(() => refresh()).catch(report)}
          onAcknowledge={operationId => setConfirmation({
            title: sourceControlOperationCopy.acknowledgeTitle,
            detail: sourceControlOperationCopy.acknowledgeDetail,
            run: async () => { await api.acknowledge({ repositoryId: repo.id, operationId }); await refresh() }
          })} />}
        <footer className="sc-action-dock">
          <div className="sc-next-summary"><span>0{primary.step} / 03</span><div><strong>{primary.step === 1 ? scope.length ? `本次提交 ${scope.length} 个文件` : '先确认这次要提交哪些文件' : primary.step === 2 ? unknown ? '先核查未知操作，不重复发送' : '下一步：推送已存在的本地提交' : '下一步：查看或创建当前分支 PR'}</strong>
            <small>{primary.step === 1 ? '未选的工作区文件不会自动加入提交。' : primary.step === 2 ? '推送不包含未提交的工作区改动。' : '本次推送已确认；GitHub 状态需另行读取。'}</small></div></div>
          <div className="sc-dock-buttons"><button disabled={busy} onClick={() => setActionsOpen(true)}>其他操作</button>
            <button className="sc-primary" disabled={busy || !active || (primary.action === 'commit' && !repo.files.length)} onClick={primaryClick}>
              {busy && runningAction ? `正在${actionNames[runningAction]}…` : primary.label}
            </button></div>
          <p className="sc-operation-status" role="status">{busy ? '正在执行已确认的操作，请等待结果。' : operations[0] ? `${actionNames[operations[0].action]} · ${statusNames[operations[0].status]} · ${operations[0].message}` : '尚未执行操作 · Git 状态与 Agent 文件证据独立'}</p>
        </footer>
      </>}
      {repo && expected && commitOpen && <SourceControlCommitDialog repo={repo} selected={selected} message={message} messageHead={messageHead}
        onSelect={toggleFile} onMessage={updateMessage} onClose={() => setCommitOpen(false)} onCommit={() => {
          setCommitOpen(false)
          void execute({ ...expected, action: 'commit', paths: selected, message }).catch(report)
        }} />}
      {repo && detailsOpen && <SourceControlRepositoryDialog repo={repo} labelledBy={dialogId} onClose={() => setDetailsOpen(false)} />}
      {repo && actionsOpen && <ModalFrame labelledBy={dialogId} onClose={() => setActionsOpen(false)}>
        <h2 id={dialogId}>其他 Git 操作</h2><div className="sc-other-actions">
          <button disabled={!repo.files.length} onClick={() => { setActionsOpen(false); setCommitOpen(true) }}>提交改动…</button>
          <button onClick={() => { setActionsOpen(false); setTransport('push') }}>推送分支…</button>
          <button onClick={() => { setActionsOpen(false); setTransport('fetch') }}>获取远端（Fetch）…</button>
          <button onClick={() => { setActionsOpen(false); setTab('pr') }}>查看 / 创建 Pull Request</button>
          <button onClick={() => { setActionsOpen(false); setTab('operations') }}>操作记录与核查</button>
        </div><button onClick={() => setActionsOpen(false)}>关闭</button>
      </ModalFrame>}
      {repo && expected && transport && <SourceControlTransportDialog repo={repo} action={transport}
        remote={remote} destination={destination} disabled={disabled} blocker={transportBlocker}
        labelledBy={dialogId} onRemoteChange={setRemote} onClose={() => setTransport(null)}
        onConfirm={() => {
          const action = transport
          setTransport(null)
          void execute({ ...expected, action, remote }).catch(report)
        }} />}
      {confirmation && <ModalFrame labelledBy={dialogId} onClose={() => setConfirmation(null)}>
        <h2 id={dialogId}>{confirmation.title}</h2><pre className="sc-confirm-detail">{confirmation.detail}</pre>
        {confirmation.blocker && <p className="sc-notice" role="alert">{confirmation.blocker}</p>}
        <div className="sc-actions"><button onClick={() => setConfirmation(null)}>取消</button>
          <button className="sc-primary" disabled={!!confirmation.blocker || busy} onClick={() => {
            const action = confirmation.run
            setConfirmation(null)
            void action().catch(report)
          }}>确认执行</button></div>
      </ModalFrame>}
    </section>
  )
}
