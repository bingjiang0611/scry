import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { githubRepositoryFromUrl, scCanMerge, type ScMutation, type ScPr, type ScPrList, type ScRead, type ScRepository, type ScReviewDraft } from '@shared/source-control'

import { defaultSourceControlApi, type SourceControlApi } from '../workbench-api'

import { GithubPullRequestPanelBody } from './GithubPullRequestPanelBody'

export function GithubPullRequestPanel({
  repo,
  active,
  busy,
  suggestedTitle,
  ask,
  report,
  api: injectedApi
}: {
  repo: ScRepository
  active: boolean
  busy: boolean
  suggestedTitle: string
  ask: (request: ScMutation, detail: string, afterSuccess?: () => Promise<void>) => void
  report: (error: unknown) => void
  api?: SourceControlApi
}) {
  const api = useMemo(() => injectedApi ?? defaultSourceControlApi, [injectedApi])
  const alive = useRef(true)
  const epoch = useRef(0)
  const lineInput = useRef<HTMLTextAreaElement>(null)
  const repositories = [...new Set(repo.remotes
    .flatMap((remote) => [...remote.pushUrls, ...remote.fetchUrls].map(githubRepositoryFromUrl))
    .filter((value): value is string => value !== null))]
  const github = repositories.length === 1 ? repositories[0] : ''
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
  const [title, setTitle] = useState(suggestedTitle)
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
    setTitle((value) => value || suggestedTitle)
  }, [suggestedTitle])
  useEffect(() => {
    if (lineTarget) lineInput.current?.focus()
  }, [lineTarget])
  useEffect(() => {
    if (!active) {
      epoch.current++
      setConfirmation(null)
      setLoadingPr(false)
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
      if (alive.current && ticket === epoch.current) report(caught)
    } finally {
      if (alive.current && ticket === epoch.current) setLoadingPr(false)
    }
  }
  async function loadPrList(): Promise<void> {
    const ticket = ++epoch.current
    setLoadingPr(true)
    report('')
    setPr(null)
    setDraft(null)
    setList(null)
    try {
      const result = await api.pullRequests({ repositoryId: repo.id, repository })
      if (!alive.current || ticket !== epoch.current) return
      setList(result)
      if (result.status === 'available') {
        setBaseBranch(result.data.defaultBranch)
        const linked = result.data.items.filter((item) => item.headBranch === repo.branch &&
          item.headRepository?.toLowerCase() === headRepository.toLowerCase())
        if (linked.length === 1) await openPr(linked[0].number)
      }
    } catch (caught) {
      if (alive.current && ticket === epoch.current) report(caught)
    } finally {
      if (alive.current && ticket === epoch.current) setLoadingPr(false)
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

  return <GithubPullRequestPanelBody
    repo={repo} busy={busy} loadingPr={loadingPr} repository={repository} repositories={repositories}
    github={github} list={list} pr={pr} draft={draft} draftState={draftState} prFile={prFile} selectedPrFile={selectedPrFile}
    lineInput={lineInput} lineTarget={lineTarget} lineBody={lineBody} title={title} body={body} baseBranch={baseBranch}
    headRepository={headRepository} createDraft={createDraft} method={method} confirmation={confirmation} dialogId={dialogId}
    prExpected={prExpected} expected={expected} staleDraft={staleDraft} scCanMerge={scCanMerge} report={report} setRepository={setRepository} setList={setList} setPr={setPr} setDraft={setDraft}
    setPrFile={setPrFile} setLineTarget={setLineTarget} setLineBody={setLineBody} setTitle={setTitle} setBody={setBody}
    setBaseBranch={setBaseBranch} setHeadRepository={setHeadRepository} setCreateDraft={setCreateDraft} setMethod={setMethod}
    setConfirmation={setConfirmation} openPr={openPr} loadPrList={loadPrList} updateDraft={updateDraft} confirm={confirm}
  />
}
