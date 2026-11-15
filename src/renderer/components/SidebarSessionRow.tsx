import { memo, type MouseEvent as ReactMouseEvent } from 'react'
import type { BackgroundWork } from '@shared/background-work'
import type { SessionProviderId } from '@shared/provider'
import type { SessionMeta } from '../env'
import { relTime } from '../format'
import { backgroundWorkStatus } from '../background-work-status'
import { composerDraftKey, type ComposerDraftStore } from '../composer-drafts'
import { SESSION_SAVE_COPY, SIDEBAR_SESSION_COPY as copy } from '../constants/copy'
import type { SessionSaveState } from '../session-save-state'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import { SessionDraftIndicator } from './SessionDraftIndicator'
import { useSessionHoverCard } from './SessionHoverCard'

// 行是 wrapper + 内部 button：会话按钮里不能再嵌按钮，操作区必须是它的兄弟节点。
export const SessionRow = memo(function SessionRow({
  session,
  cwd,
  projectName,
  showProjectName = false,
  motionKey,
  active,
  running,
  waitingForAnswer,
  unread,
  backgroundWork,
  draftStore,
  onPick,
  onTogglePin,
  onArchive,
  onMenu,
  saveState
}: {
  session: SessionMeta
  // Invalidate memo on parent refreshes; local hover/focus renders also refresh the age below.
  relativeTime: string
  cwd: string
  projectName?: string
  showProjectName?: boolean
  motionKey?: string
  active: boolean
  running: boolean
  waitingForAnswer: boolean
  unread: boolean
  backgroundWork?: BackgroundWork
  draftStore?: ComposerDraftStore
  onPick: (cwd: string, sessionId: string, providerId: SessionProviderId, externalSessionId?: string, runId?: string, agentProfileId?: string, previewText?: string, previewRunId?: string) => void
  onTogglePin: (cwd: string, session: SessionMeta) => void
  onArchive: (cwd: string, session: SessionMeta) => void
  onMenu?: (event: ReactMouseEvent<HTMLButtonElement>, cwd: string, session: SessionMeta) => void
  saveState?: SessionSaveState
}) {
  const pinned = Boolean(session.pinnedAt)
  const status = running ? backgroundWorkStatus(backgroundWork) : undefined
  const hover = useSessionHoverCard(session, cwd, projectName, running, status?.label)
  return (
    <div className="sb-sess-row" data-motion-key={motionKey}>
      <button
        type="button"
        className={['sb-sess', active && 'active', running && 'running', waitingForAnswer && 'waiting-answer', unread && 'unread'].filter(Boolean).join(' ')}
        data-provider={session.providerId}
        {...hover.triggerProps}
        aria-current={active ? 'true' : undefined}
        onContextMenu={onMenu ? (event) => { hover.dismiss(); onMenu(event, cwd, session) } : undefined}
        onClick={() => {
          hover.dismiss()
          onPick(
            cwd,
            session.sessionId,
            session.providerId,
            session.externalSessionId,
            running ? session.runId : undefined,
            session.agentProfileId,
            session.preview,
            session.runId
          )
        }}
      >
        <span className="sb-session-main">
          {session.providerId === 'legacy_unknown' ? (
            <span className="sb-provider" data-provider="legacy_unknown">{copy.legacy}</span>
          ) : (
            <ProviderGlyph
              className="sb-provider"
              provider={session.providerId}
              label={copy.providers[session.providerId]}
            />
          )}
          {draftStore && <SessionDraftIndicator store={draftStore} draftKey={composerDraftKey({
            providerId: session.providerId, agentProfileId: session.agentProfileId, cwd,
            sessionId: session.externalSessionId ?? session.sessionId
          })} />}
          <span className="sb-sesstext">{session.preview || copy.noPreview}</span>
        </span>
        <span className="sb-session-meta">
          {/* Saving / Saved take the time's fixed place; the change itself is never covered. */}
          {!waitingForAnswer && (saveState?.status === 'saving' || saveState?.status === 'saved'
            ? <span className="sb-sesstime sb-sess-save" data-save={saveState.status} role="status">
              {saveState.status === 'saving' ? SESSION_SAVE_COPY.saving : <><Icon name="check" /> {SESSION_SAVE_COPY.saved}</>}
            </span>
            : <span className="sb-sesstime">{relTime(session.mtime)}</span>)}
          {unread && !waitingForAnswer && <span className="sb-unread" role="status" aria-label={copy.unread} title={copy.unread} />}
          {waitingForAnswer && (
            <span className="sb-question-pending" role="status" aria-label={copy.waiting} title={copy.waiting}>
              <Icon name="message" /> {copy.answer}
            </span>
          )}
          {showProjectName && projectName && <span className="sb-sess-proj">{projectName}</span>}
        </span>
        {running && !waitingForAnswer && <span className="sb-running" role="status" data-background-waiting={status?.waiting || undefined} aria-label={status?.label ?? copy.running} title={status?.label ?? copy.running} />}
      </button>
      {hover.tooltip}
      {saveState?.status === 'failed' && (
        <div className="sb-sess-save-error" role="alert">
          <span>{SESSION_SAVE_COPY.failed(saveState.action, saveState.reason)}</span>
          <button type="button" onClick={() => (saveState.action === 'pin' ? onTogglePin : onArchive)(cwd, session)}>{SESSION_SAVE_COPY.retry}</button>
        </div>
      )}
      <span className="sb-sess-acts" onMouseEnter={hover.dismiss} onFocus={hover.dismiss}>
        {onMenu && <button type="button" className="sb-act" aria-haspopup="menu"
          title={copy.actions} aria-label={copy.sessionActions(session.preview)}
          onClick={(event) => onMenu(event, cwd, session)}>{copy.moreGlyph}</button>}
        <button
          type="button"
          className={`sb-act ${pinned ? 'on' : ''}`}
          title={pinned ? copy.unpin : copy.pin}
          aria-label={copy.pinSession(session.preview, pinned)}
          aria-pressed={pinned}
          onClick={() => onTogglePin(cwd, session)}
        >
          <Icon name="pin" />
        </button>
        <button
          type="button"
          className="sb-act"
          title={running ? copy.archiveRunning : copy.archive}
          aria-label={copy.archiveSession(session.preview)}
          onClick={() => onArchive(cwd, session)}
        >
          <Icon name="archive" />
        </button>
      </span>
    </div>
  )
})
