import { useId, useRef, useState } from 'react'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import { providerIdForAgentId } from '@shared/runtime'
import { REMOTE_SESSION_COPY as copy } from '../constants/copy'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import type { RemoteProjectGroup } from './SidebarRemoteProjects'
import { ModalFrame } from './Modals'
import { bridge } from './DesktopRemote'
import { Icon } from './primitives/Icon'

type ArchivedTarget = { group: RemoteProjectGroup; session: RemoteSessionRef }

export function ArchivedRemoteChatsPanel({ groups }: { groups: RemoteProjectGroup[] }) {
  const [deleting, setDeleting] = useState<ArchivedTarget | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writing = useRef(false)
  const titleId = useId()
  const deleteTitleId = useId()

  const change = async ({ group, session }: ArchivedTarget, remove: boolean): Promise<void> => {
    const current = groups.find(candidate => candidate.key === group.key)
    if (writing.current || !(remove ? current?.canDelete : current?.canManage)) return
    writing.current = true
    setPending(true)
    setError(null)
    try {
      if (remove) {
        const providerId = providerIdForAgentId(session.providerId)
        if (!providerId || !session.externalSessionId) return
        const result = await bridge().deleteSession(group.connection.id, {
          providerId, agentProfileId: session.agentProfileId, cwd: session.cwd,
          externalSessionId: session.externalSessionId, confirmed: true
        })
        if (!result.ok) throw new Error(copy.deleteFailed(result.failed.map(failure => failure.error).join('; ') || result.reason || 'unknown'))
      } else {
        const changed = await bridge().sessionAction(group.connection.id, {
          cwd: group.cwd, providerId: session.providerId, agentProfileId: session.agentProfileId,
          externalSessionId: session.externalSessionId
        }, { kind: 'archive', archived: false })
        if (!changed) throw new Error(copy.updateUnconfirmed)
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.includes('desktop_session_operation_unknown') ? copy.operationUnknown : message)
    } finally {
      setDeleting(null)
      writing.current = false
      setPending(false)
      // A failed response may follow a committed write. Read back without retrying.
      void refreshRemoteCatalog(group.connection.id)
    }
  }

  if (groups.length === 0 && !error && !deleting) return null

  return <section aria-labelledby={groups.length > 0 ? titleId : undefined}>
    {groups.length > 0 && <>
      <div className="arch-head">
        <div className="settings-copy">
          <b id={titleId}>{copy.archivedTitle}</b>
          <span>{copy.archivedDescription}</span>
        </div>
      </div>
      <div className="arch-list">
        {groups.map(group => <section className="arch-group" key={group.key}>
          <header className="arch-group-head">
            <Icon name="folder" /><b>{group.name}</b><span>{group.connection.label}</span>
          </header>
          <div className="arch-group-body">
            {group.sessions.map(session => {
              const canIdentify = providerIdForAgentId(session.providerId) !== undefined
              return <div className="arch-row" key={`${session.providerId}:${session.agentProfileId ?? ''}:${session.externalSessionId}`}
              data-archived-remote-session={session.externalSessionId}>
              <div className="arch-row-copy">
                <b title={session.label}>{session.label}</b>
                <div className="arch-row-meta"><span>{session.providerId}</span><span>{group.cwd}</span></div>
              </div>
              <div className="arch-row-acts">
                <button type="button" className="arch-del" disabled={pending || !group.canDelete || !canIdentify}
                  title={!canIdentify ? copy.deleteUnsupported : group.canDelete ? copy.delete : copy.manageUnavailable(group.connection.label)} aria-label={copy.delete}
                  onClick={() => setDeleting({ group, session })}><Icon name="trash" /></button>
                <button type="button" className="arch-unarch" disabled={pending || !group.canManage}
                  title={group.canManage ? copy.restore : copy.manageUnavailable(group.connection.label)} aria-label={copy.restoreLabel(session.label)}
                  onClick={() => { void change({ group, session }, false) }}><Icon name="undo" />{copy.restore}</button>
              </div>
            </div>})}
          </div>
        </section>)}
      </div>
    </>}
    {error && <div className="arch-failures" role="alert">{error}</div>}
    {deleting && <ModalFrame labelledBy={deleteTitleId} onClose={() => { if (!pending) setDeleting(null) }}>
      <div className="modal-head"><b id={deleteTitleId}>{copy.deleteTitle(deleting.group.connection.label)}</b></div>
      <div className="modal-body"><p>{copy.deleteWarning(deleting.session.label)}</p></div>
      <div className="modal-foot">
        <button type="button" className="btn" disabled={pending} onClick={() => setDeleting(null)}>{copy.cancel}</button>
        <button type="button" className="btn danger" disabled={pending || !groups.some(group => group.key === deleting.group.key && group.canDelete)} onClick={() => { void change(deleting, true) }}>{pending ? copy.deleting : copy.delete}</button>
      </div>
    </ModalFrame>}
  </section>
}
