import type { ConversationSummary } from '@shared/conversation-api'
import { SIDE_CHAT_DEFAULT_TITLE } from '@shared/conversation'
import type { ComposerDraftStore } from '../composer-drafts'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import type { WorkspaceFileTarget } from '../workspace-links'
import { useSideChatInstance } from '../hooks/useSideChatInstance'
import { ConversationView, type ConversationProjection } from './ConversationView'
import { DiffInspector } from './DiffInspector'

import '../side-chat.css'

/** Readonly replacement for the folder picker: a side chat cannot move its workspace. */
export function SideChatWorkspaceLabel({ cwd }: { cwd: string }) {
  // The shared workspace is the parent's directory. Printing its last path segment added a
  // UUID or a folder name the user never picked here; the full path stays on the tooltip.
  return <span className="side-chat-workspace" data-side-chat-workspace={cwd} title={cwd}>
    {SIDE_CHAT_COPY.sharedWorkspace}
  </span>
}

/**
 * Frame of one side chat: one captured source line and the frozen boundary, nothing else.
 *
 * The child's own title is not repeated here: a workbench tab already prints it, and the
 * main pane prints it in the conversation toolbar. This frame carries no actions either;
 * closing, refreshing and conversation management belong to the tab strip and the main
 * pane, so the side chat cannot offer a second, half-working copy of that chrome.
 */
export function SideChatHeader({ summary, cwd }: {
  summary: ConversationSummary['sideChat']
  cwd: string
}) {
  return <header className="side-chat-surface-header">
    <p className="side-chat-surface-provenance" data-side-chat-provenance data-side-chat-workspace={cwd}>
      {summary
        ? <>
          <span className="side-chat-surface-source">
            <span className="side-chat-surface-source-label">{SIDE_CHAT_COPY.sourceLabel}</span>
            <span className="side-chat-surface-parent" title={summary.parentTitleAtCapture}
              data-side-chat-parent-title>{summary.parentTitleAtCapture}</span>
          </span>
          <span className="side-chat-surface-boundary">{SIDE_CHAT_COPY.snapshotLine(summary.throughOrdinal)}</span>
        </>
        : <span>{SIDE_CHAT_COPY.surfaceSubtitle}</span>}
    </p>
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
export function SideChatSurface({ conversation, draftStore, agents, onOpenFile, onOpenConversation, onChanged, onProjection, autoFocusComposer, variant = 'frame', liveVisible = true }: {
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
  const summary = conversation.sideChat
  const status = instance.blockedReason ?? instance.notice

  return <section className={variant === 'main' ? 'side-chat-surface side-chat-surface-main' : 'side-chat-surface'}
    aria-label={SIDE_CHAT_COPY.surfaceLabel}
    data-side-chat-id={conversation.id} data-side-chat-variant={variant}
    data-side-chat-send-blocked={instance.blockedReason ? 'true' : undefined}>
    <SideChatHeader summary={summary} cwd={conversation.cwd} />
    {status && <p className="side-chat-surface-notice" role="status" data-side-chat-notice>{status}</p>}
    <ConversationView
      liveVisible={liveVisible} embedded={variant === 'frame'} conversation={conversation} draftStore={draftStore} chatProps={instance.chatProps}
      onChanged={onChanged}
      onProjection={projection => { instance.applyProjection(projection); onProjection?.(projection) }}
      onOpenConversation={onOpenConversation}
      {...(instance.initialViewPosition ? { initialViewPosition: instance.initialViewPosition } : {})}
    />
    {instance.diffSelection && <div className="side-chat-diff-panel" data-side-chat-diff>
      <p className="side-chat-diff-header" data-side-chat-diff-title>
        {SIDE_CHAT_COPY.diffScope(conversation.title ?? SIDE_CHAT_DEFAULT_TITLE)}
      </p>
      <DiffInspector state={instance.diff} onClose={instance.closeDiff} />
    </div>}
  </section>
}
