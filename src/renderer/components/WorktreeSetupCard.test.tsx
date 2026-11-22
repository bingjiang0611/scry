import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePrepareProgress } from '@shared/workspace-selection'
import { WorktreeSetupCard } from './WorktreeSetupCard'
import { ChatView } from './ChatView'
import { workspaceCopy as copy } from '../constants/workspace-copy'

const baseProgress = (overrides: Partial<WorkspacePrepareProgress> = {}): WorkspacePrepareProgress => ({
  operationId: '11111111-1111-4111-8111-111111111111',
  repositoryId: 'a'.repeat(64),
  stage: 'preparing',
  workspacePrepared: false,
  cancellable: true,
  details: ['准备分支 scry/demo'],
  branch: 'scry/demo',
  baseRef: 'main',
  updatedAt: 1000,
  ...overrides
})

describe('WorktreeSetupCard', () => {
  it('renders preparing stage without a fabricated checkout percentage', () => {
    const html = renderToStaticMarkup(
      <WorktreeSetupCard progress={baseProgress()} onCancel={() => {}} />
    )
    expect(html).toContain(copy.creatingWorktree)
    expect(html).toContain(copy.stepPreparingWorkspace)
    expect(html).toContain(copy.stepCheckingOutFiles)
    expect(html).toContain(copy.moreDetails)
    expect(html).toContain(copy.cancelSetup)
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('%')
  })

  it('renders indeterminate progress bar when checking out before Git reports a real percent', () => {
    const html = renderToStaticMarkup(
      <WorktreeSetupCard
        progress={baseProgress({ stage: 'checking_out', workspacePrepared: true })}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('is-indeterminate')
    expect(html).not.toContain('worktree-setup-percent')
  })

  it('renders determinate percentage and disables cancel once handoff or cancellation begins', () => {
    const html = renderToStaticMarkup(
      <WorktreeSetupCard
        progress={baseProgress({
          stage: 'checking_out',
          workspacePrepared: true,
          checkout: { completed: 64, total: 100, percent: 64 },
          cancellable: false
        })}
        cancelling
        onCancel={() => {}}
      />
    )
    expect(html).toContain(copy.cancellingWorktree)
    expect(html).toContain('aria-valuenow="64"')
    expect(html).toContain('64%')
    expect(html).toContain(copy.cancellingSetup)
    expect(html).toContain('disabled=""')
  })

  it('integrates into ChatView for remote/local worktree setup and switches composer to waiting state', () => {
    const html = renderToStaticMarkup(
      <ChatView
        turns={[]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/workspace"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        runControls={{ permissionMode: 'default' }}
        runControlCatalog={{ models: [], permissions: [] }}
        input="draft stays durable in store"
        busy={false}
        draftAttachments={[]}
        queuedPrompts={[]}
        slashOpen={false}
        slashLoading={false}
        slashCmds={[]}
        slashSel={0}
        onSelect={vi.fn()}
        onInput={vi.fn()}
        onChooseFolder={vi.fn()}
        onPickRecent={vi.fn()}
        onRemoveRecent={vi.fn()}
        onRetrySlash={vi.fn()}
        onPickSlash={vi.fn()}
        onSlashSel={vi.fn()}
        onHideSlash={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onPasteImages={vi.fn()}
        onPasteClipboardImage={vi.fn()}
        onRemoveDraftAttachment={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onSelectAgent={vi.fn()}
        onRunModel={vi.fn()}
        onRunEffort={vi.fn()}
        onPermissionMode={vi.fn()}
        workspaceSetup={{
          prompt: '新建功能分支并实现',
          progress: baseProgress({
            stage: 'checking_out',
            workspacePrepared: true,
            checkout: { completed: 25, total: 50, percent: 50 }
          }),
          onCancel: vi.fn()
        }}
      />
    )
    expect(html).toContain('新建功能分支并实现')
    expect(html).toContain(copy.creatingWorktree)
    expect(html).toContain('50%')
    expect(html).toContain(copy.waitingForWorktreeSetup)
    expect(html).toContain('is-worktree-waiting')
    expect(html).not.toContain('今天想在')
    // Real textarea DOM value stays durable until ACK (masked visually by waiting overlay).
    expect(html).toContain('draft stays durable in store')
  })
})
