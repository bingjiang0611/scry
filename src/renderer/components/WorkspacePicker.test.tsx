import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSelectionController } from '../hooks/useWorkspaceSelection'
import { workspaceCopy } from '../constants/workspace-copy'
import { WorkspaceContext } from './WorkspacePicker'

function renderContext(blockedReason?: string) {
  const controller: WorkspaceSelectionController = {
    selection: { operationId: 'draft-operation', intent: { kind: 'newWorktree', repositoryId: 'repo', expectedRevision: 'revision',
      base: { kind: 'local', name: 'refs/heads/main', head: 'head' }, newBranch: 'scry/12345678' } },
    sendLabel: workspaceCopy.createSend,
    editor: { key: 'draft', menu: 'workspace', query: '' },
    open: false, close: vi.fn(), show: vi.fn(), changeEditor: vi.fn(),
    choices: undefined, metadata: undefined, loading: false, validating: false, error: undefined,
    refresh: vi.fn(), nextPage: vi.fn(), firstPage: vi.fn(), reset: vi.fn(),
    chooseNewWorktree: vi.fn(async () => {}), chooseBranch: vi.fn(async () => {}), chooseWorktree: vi.fn(async () => {}),
    inspect: vi.fn(async () => {}), operation: undefined,
    blockedReason, canChange: !blockedReason, busy: false, editable: true
  }
  return renderToStaticMarkup(<WorkspaceContext controller={controller} cwd="/workspace" onOpenRun={vi.fn()} />)
}

describe('compact workspace context', () => {
  it('keeps an ordinary saved selection to two triggers without recovery or form controls', () => {
    const html = renderContext()
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).not.toContain('workspace-context-recovery')
    expect(html).not.toContain('workspace-apply')
    expect(html).not.toMatch(/<p(?:\s|>)/)
  })

  it('keeps read-only recovery reachable when inspection failed before returning an operation', () => {
    const html = renderContext('inspection unavailable')
    expect(html).toContain('workspace-context-recovery')
    expect(html).toContain(workspaceCopy.inspect)
    expect(html).toContain('inspection unavailable')
  })

  it('does not show recovery actions while the first inspection is pending', () => {
    const html = renderContext(workspaceCopy.loading)
    expect(html).not.toContain('workspace-context-recovery')
    expect(html).not.toContain(workspaceCopy.loading)
  })
})
