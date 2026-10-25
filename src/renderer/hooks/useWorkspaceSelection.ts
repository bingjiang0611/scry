import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkspaceBranchChoice, WorkspaceBranchRef, WorkspaceChoices, WorkspaceChoicesRequest, WorkspaceIntent, WorkspaceStartStatus, WorkspaceWorktreeChoice } from '@shared/workspace-selection'
import type { ScRead } from '@shared/source-control'
import type { ComposerDraftStore } from '../composer-drafts'
import { updateSessionComposerDraft } from '../app-model'
import { workspaceCopy as copy } from '../constants/workspace-copy'
import { workspaceSendLabel } from '../workspace-drafts'

type Menu = 'workspace' | 'refs'
interface Editor {
  key: string
  menu: Menu
  query: string
  cursor?: WorkspaceChoicesRequest['cursor']
}

export function useWorkspaceSelection({ cwd, draftKey, draftStore, editable, active, busy, selectionEpoch }: {
  cwd: string | null
  draftKey: string
  draftStore: ComposerDraftStore
  editable: boolean
  active: boolean
  busy: boolean
  selectionEpoch: number
}) {
  const readSelection = () => draftStore.getSnapshot().get(draftKey)?.workspace
  const storedSelection = useSyncExternalStore(draftStore.subscribe, readSelection, readSelection)
  const selection = editable ? storedSelection : undefined
  const key = JSON.stringify([cwd, draftKey, selectionEpoch])
  const currentKey = useRef(key)
  currentKey.current = key
  const initial: Editor = { key, menu: 'workspace', query: '' }
  const [editorState, setEditor] = useState(initial)
  const editor = editorState.key === key ? editorState : initial
  const [openKey, setOpenKey] = useState<string | null>(null)
  const open = openKey === key && editable && !busy
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ key: string; queryKey: string; value: ScRead<WorkspaceChoices> }>()
  const [errorState, setError] = useState<{ key: string; message: string }>()
  const [validating, setValidating] = useState(false)
  const readSequence = useRef(0)
  const inspectSequence = useRef(0)
  const applySequence = useRef(0)
  const kind = editor.menu === 'workspace' ? 'worktrees' : 'branches'
  const selectedWorktreeId = selection && !('invalid' in selection) && selection.intent.kind === 'existingWorktree'
    ? selection.intent.worktreeId : undefined
  const queryKey = JSON.stringify([kind, editor.query, editor.cursor, selectedWorktreeId])
  const metadata = result?.key === key && result.value.status === 'available' ? result.value.data : undefined
  const choices = result?.key === key && result.queryKey === queryKey && result.value.status === 'available' ? result.value.data : undefined
  const readError = result?.key === key && result.value.status !== 'available' ? result.value.reason : undefined
  const statusKey = selection && !('invalid' in selection) ? JSON.stringify([key, selection.operationId]) : undefined
  const [inspection, setInspection] = useState<{ key: string; value: ScRead<WorkspaceStartStatus | null> }>()
  const inspected = inspection && inspection.key === statusKey ? inspection.value : undefined
  const operation = inspected?.status === 'available' ? inspected.data : undefined

  useEffect(() => {
    const sequence = ++readSequence.current
    if (!active || !cwd) return
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.scry.workspaceSelection.read({ cwd, kind, query: editor.query, cursor: editor.cursor, selectedWorktreeId })
        .then(value => {
          if (sequence === readSequence.current && currentKey.current === key) setResult({ key, queryKey, value })
        }, error => {
          if (sequence === readSequence.current && currentKey.current === key)
            setResult({ key, queryKey, value: { status: 'failed', reason: copy.failure(error) } })
        }).finally(() => { if (sequence === readSequence.current) setLoading(false) })
    }, editor.query ? 200 : 0)
    return () => { window.clearTimeout(timer); readSequence.current++ }
  }, [active, cwd, key, kind, queryKey, refreshKey, open])

  const inspect = useCallback(async (): Promise<void> => {
    if (!selection || 'invalid' in selection || !statusKey || !metadata) return
    const sequence = ++inspectSequence.current
    if (selection.intent.repositoryId !== metadata.repositoryId) {
      setInspection({ key: statusKey, value: { status: 'failed', reason: copy.invalidSelection } })
      return
    }
    try {
      const value = await window.scry.workspaceSelection.inspectStart({
        repositoryId: selection.intent.repositoryId, operationId: selection.operationId
      })
      if (sequence === inspectSequence.current && currentKey.current === key) setInspection({ key: statusKey, value })
    } catch (error) {
      if (sequence === inspectSequence.current && currentKey.current === key)
        setInspection({ key: statusKey, value: { status: 'failed', reason: copy.failure(error) } })
    }
  }, [selection, statusKey, metadata?.repositoryId, key])
  useEffect(() => {
    if (active && editable && !busy) void inspect()
    return () => { inspectSequence.current++ }
  }, [active, editable, busy, inspect])

  const operationBlocked = Boolean(operation && ['git_requested', 'start_requested', 'registered'].includes(operation.phase))
  const blockedReason = !editable || !selection ? undefined
    : 'invalid' in selection ? copy.invalidSelection
      : readError ?? (!inspected ? copy.loading : inspected.status !== 'available' ? inspected.reason
        : operationBlocked ? operation?.phase === 'registered' ? copy.registered : copy.unknown : undefined)
  const canChange = editable && !busy && !operationBlocked && (!selection || 'invalid' in selection || Boolean(inspected?.status === 'available'))

  useEffect(() => {
    applySequence.current++
    setOpenKey(null)
    setValidating(false)
    setError(undefined)
  }, [key])
  useEffect(() => {
    if (busy || !editable) { applySequence.current++; setOpenKey(null); setValidating(false) }
  }, [busy, editable])

  const changeEditor = (patch: Partial<Omit<Editor, 'key'>>): void => {
    setEditor({ ...editor, ...patch })
    setError(undefined)
  }
  const close = (): void => { applySequence.current++; setOpenKey(null); setValidating(false); setError(undefined) }
  const apply = async (intent: WorkspaceIntent): Promise<void> => {
    if (!canChange || !choices || loading || validating) return
    const capturedKey = key
    const sequence = ++applySequence.current
    setValidating(true)
    setError(undefined)
    try {
      if (intent.kind === 'newWorktree') {
        const validated = await window.scry.workspaceSelection.validateBranch({ repositoryId: choices.repositoryId, name: intent.newBranch })
        if (validated.status !== 'available') throw new Error(validated.reason)
        intent = { ...intent, newBranch: validated.data.name }
      }
      if (currentKey.current !== capturedKey || sequence !== applySequence.current) return
      const unchanged = intent.kind === 'current' && (!intent.branch || intent.branch.name === `refs/heads/${choices.branch}`)
      draftStore.update(current => updateSessionComposerDraft(current, draftKey, draft => {
        const { workspace: _old, ...rest } = draft
        return unchanged ? rest : { ...rest, workspace: { operationId: crypto.randomUUID(), intent } }
      }))
      close()
    } catch (error) {
      if (currentKey.current === capturedKey && sequence === applySequence.current) setError({ key, message: copy.failure(error) })
    } finally {
      if (currentKey.current === capturedKey && sequence === applySequence.current) setValidating(false)
    }
  }
  const reset = (): void => {
    if (!canChange) return
    draftStore.update(current => updateSessionComposerDraft(current, draftKey, draft => {
      const { workspace: _old, ...rest } = draft
      return rest
    }))
    setEditor(initial)
    close()
  }

  const intent = selection && !('invalid' in selection) ? selection.intent : undefined
  const chooseNewWorktree = async (base?: WorkspaceBranchRef): Promise<void> => {
    if (!choices?.head) return
    const selectedBase = base ?? (intent?.kind === 'current' ? intent.branch : intent?.kind === 'newWorktree' ? intent.base : undefined)
      ?? (choices.branch ? { kind: 'local' as const, name: `refs/heads/${choices.branch}`, head: choices.head } : undefined)
    if (!selectedBase) { setError({ key, message: copy.chooseBase }); return }
    await apply({ repositoryId: choices.repositoryId, expectedRevision: choices.revision, kind: 'newWorktree', base: selectedBase,
      newBranch: intent?.kind === 'newWorktree' ? intent.newBranch : `scry/${crypto.randomUUID().slice(0, 8)}` })
  }
  const chooseBranch = async (branch: WorkspaceBranchChoice): Promise<void> => {
    if (!choices) return
    if (intent?.kind === 'newWorktree') { await chooseNewWorktree(branch); return }
    if (branch.kind !== 'local') return
    await apply({ repositoryId: choices.repositoryId, expectedRevision: choices.revision, kind: 'current', branch })
  }
  const chooseWorktree = async (tree: WorkspaceWorktreeChoice): Promise<void> => {
    if (!choices || tree.busy || tree.bare || tree.locked !== null || tree.prunable !== null) return
    await apply({ repositoryId: choices.repositoryId, expectedRevision: choices.revision, kind: 'existingWorktree', worktreeId: tree.id })
  }

  return {
    sendLabel: workspaceSendLabel(selection, metadata), selection, editor, open, close, show: (menu: Menu) => {
      if (canChange) { setEditor({ key, menu, query: '' }); setError(undefined); setOpenKey(key) }
    }, changeEditor,
    choices, metadata, loading, validating, error: errorState?.key === key ? errorState.message : readError,
    refresh: () => { changeEditor({ cursor: undefined }); setRefreshKey(value => value + 1) },
    nextPage: () => { if (choices?.nextCursor) changeEditor({ cursor: choices.nextCursor }) },
    firstPage: () => changeEditor({ cursor: undefined }), chooseNewWorktree, chooseBranch, chooseWorktree, reset, inspect, operation,
    blockedReason, canChange, busy, editable
  }
}

export type WorkspaceSelectionController = ReturnType<typeof useWorkspaceSelection>
