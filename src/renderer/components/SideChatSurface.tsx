import { useState } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import { SIDE_CHAT_DEFAULT_TITLE } from '@shared/conversation'
import type { ComposerDraftStore } from '../composer-drafts'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import type { WorkspaceFileTarget } from '../workspace-links'
import { useSideChatInstance } from '../hooks/useSideChatInstance'
import { ConversationView, type ConversationProjection } from './ConversationView'
import { DiffInspector } from './DiffInspector'
import { SideChatSnapshotViewer } from './SideChatSnapshotViewer'

import '../side-chat.css'

/** Readonly replacement for the folder picker: a side chat cannot move its workspace. */
export function SideChatWorkspaceLabel({ cwd }: { cwd: string }) {
  const name = cwd.split('/').filter(Boolean).at(-1) ?? cwd
  return <span className="side-chat-workspace" data-side-chat-workspace={cwd} title={cwd}>
    {SIDE_CHAT_COPY.workspaceReadonly(name)}
  </span>
}

/**
 * Frame of one side chat: the single title of this surface, one compact line of
 * provenance, and two actions.
 *
 * The title lives here and nowhere else in the workbench: the conversation body below is
 * the same view the main pane uses, so it is told not to repeat a second heading. The
 * source line keeps only what the body cannot say — which parent it was frozen from and
 * how far it was carried — because the workspace already has its own readonly label.
 */
export function SideChatHeader({ title, summary, cwd, snapshotOpen, onToggleSnapshot, onClose, variant = 'frame' }: {
  title?: string
  summary: ConversationSummary['sideChat']
  cwd: string
  snapshotOpen: boolean
  onToggleSnapshot: () => void
  /** Absent when this surface is the main view: a conversation has no tab to close. */
  onClose?: () => void
  /** `main` drops the title row, because the main conversation body already prints it. */
  variant?: 'frame' | 'main'
}) {
  const name = title ?? SIDE_CHAT_DEFAULT_TITLE
  return <header className="side-chat-surface-header">
    <div className="side-chat-surface-heading">
      {variant === 'frame' && <h2 className="side-chat-surface-title" title={name}>{name}</h2>}
      {/* The workspace is already named by the composer's readonly location label; keeping
          it here only truncated the captured parent title at narrow widths. */}
      <p className="side-chat-surface-provenance" data-side-chat-provenance data-side-chat-workspace={cwd}>
        {summary
          ? <>
            <span className="side-chat-surface-parent" title={summary.parentTitleAtCapture}
              data-side-chat-parent-title>{summary.parentTitleAtCapture}</span>
            <span className="side-chat-surface-sep" aria-hidden="true">·</span>
            <span>{SIDE_CHAT_COPY.snapshotLine(summary.throughOrdinal)}</span>
          </>
          : <span>{SIDE_CHAT_COPY.surfaceSubtitle}</span>}
      </p>
    </div>
    <div className="side-chat-surface-actions">
      {summary && <button type="button" className="btn" onClick={onToggleSnapshot}
        aria-expanded={snapshotOpen}>{SIDE_CHAT_COPY.snapshotDetail}</button>}
      {onClose && <button type="button" className="btn" onClick={onClose} aria-label={SIDE_CHAT_COPY.surfaceClose}>{SIDE_CHAT_COPY.surfaceClose}</button>}
    </div>
  </header>
}

/**
 * One side chat as its own surface.
 *
 * The instance controller owns selection, refs, navigation, errors, attachments and
 * the diff panel for this child. This surface deliberately takes no host prop bag: the
 * only things it borrows are the readonly agent list and the explicit `onOpenFile` /
 * `onOpenConversation` host decisions. Agent installation, PATH rescans and Provider
 * detection belong to the host view and are not offered here, so a child cannot mutate
 * the host's global agent selection.
 */
export function SideChatSurface({ conversation, draftStore, agents, onOpenFile, onOpenConversation, onChanged, onProjection, onClose, autoFocusComposer, variant = 'frame', liveVisible = true }: {
  conversation: ConversationSummary
  draftStore: ComposerDraftStore
  agents: ConversationHostChatProps['agents']
  onOpenFile?: (target: WorkspaceFileTarget) => void
  /** Opening another conversation is a host decision, never done inside this surface. */
  onOpenConversation: (conversation: ConversationSummary) => void
  /** The child's own title, bindings or metadata changed; the host refreshes its list. */
  onChanged: () => void
  /** The main host also needs the projection for its overview; a tab does not. */
  onProjection?: (projection: ConversationProjection) => void
  /** Only a workbench tab has a close affordance; the main view leaves by navigation. */
  onClose?: () => void
  /** Only a just-created child takes composer focus; a tab switch does not. */
  autoFocusComposer?: boolean
  /**
   * Where this instance is rendered. `frame` is one workbench tab, `main` is the main pane,
   * which is how a side chat is opened after its source leaves the loaded list. Both share
   * this one component so a child never inherits the host's global runtime controls.
   */
  variant?: 'frame' | 'main'
  liveVisible?: boolean
}) {
  const instance = useSideChatInstance({
    conversation, agents, onOpenFile,
    ...(autoFocusComposer ? { autoFocusComposer: true } : {}),
    renderLocationPicker: () => <SideChatWorkspaceLabel cwd={conversation.cwd} />
  })
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const summary = conversation.sideChat
  const status = instance.blockedReason ?? instance.notice

  return <section className={variant === 'main' ? 'side-chat-surface side-chat-surface-main' : 'side-chat-surface'}
    aria-label={SIDE_CHAT_COPY.surfaceLabel}
    data-side-chat-id={conversation.id} data-side-chat-variant={variant}
    data-side-chat-send-blocked={instance.blockedReason ? 'true' : undefined}>
    <SideChatHeader title={conversation.title} summary={summary} cwd={conversation.cwd} snapshotOpen={snapshotOpen}
      variant={variant} onToggleSnapshot={() => setSnapshotOpen(value => !value)} {...(onClose ? { onClose } : {})} />
    {status && <p className="side-chat-surface-notice" role="status" data-side-chat-notice>{status}</p>}
    <ConversationView
      liveVisible={liveVisible} embedded={variant === 'frame'} conversation={conversation} draftStore={draftStore} chatProps={instance.chatProps}
      onChanged={onChanged}
      onProjection={projection => { instance.applyProjection(projection); onProjection?.(projection) }}
      onOpenConversation={onOpenConversation}
      {...(instance.initialViewPosition ? { initialViewPosition: instance.initialViewPosition } : {})}
    />
    {snapshotOpen && summary && <SideChatSnapshotViewer conversationId={conversation.id} summary={summary}
      onClose={() => setSnapshotOpen(false)} />}
    {instance.diffSelection && <div className="side-chat-diff-panel" data-side-chat-diff>
      <p className="side-chat-diff-header" data-side-chat-diff-title>
        {SIDE_CHAT_COPY.diffScope(conversation.title ?? SIDE_CHAT_DEFAULT_TITLE)}
      </p>
      <DiffInspector state={instance.diff} onClose={instance.closeDiff} />
    </div>}
  </section>
}
