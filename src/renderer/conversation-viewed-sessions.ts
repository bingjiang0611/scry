import { useEffect, useState } from 'react'
import type { ConversationPage } from '@shared/conversation-api'
import { sessionAttentionKey } from '@shared/session-attention'

// A unified conversation shows one native session per Provider binding, and none of its
// runs is the window's focused run. Main only learns what is on screen if the view says
// so; otherwise every reply the conversation receives stays unread for good.

const MAX_KEYS = 16

type ViewedPage = Pick<ConversationPage, 'summary' | 'bindings'> & Partial<Pick<ConversationPage, 'turns'>>

export interface SessionNotice {
  runId: string
  sessionId: string
  providerId?: string
  agentProfileId?: string
  pending?: boolean
}

/** The badge keys of the native sessions this page shows; live bindings first. */
export function conversationSessionKeys(page: ViewedPage | undefined): string[] {
  if (!page) return []
  const ordered = [...page.bindings].sort((a, b) => Number(Boolean(a.retiredReason)) - Number(Boolean(b.retiredReason)))
  const keys = new Set<string>()
  for (const binding of ordered) {
    if (!binding.nativeSessionId) continue
    keys.add(sessionAttentionKey({
      providerId: binding.providerId, agentProfileId: binding.agentProfileId,
      cwd: page.summary.cwd, sessionId: binding.nativeSessionId
    }))
  }
  return [...keys].slice(0, MAX_KEYS)
}

/**
 * A run of this conversation learned its native session. The page names it only once
 * it is read again, which can be after the turn ended: a new binding's first reply
 * would count as unread for that moment. The notice names it first.
 */
export function noticeSessionKey(page: ViewedPage | undefined, notice: SessionNotice): string | undefined {
  if (!page || notice.pending || !notice.sessionId) return undefined
  const turn = page.turns?.find((item) => item.runId === notice.runId)
  if (!turn && page.summary.activeRunId !== notice.runId) return undefined
  const binding = turn ? page.bindings.find((item) => item.id === turn.bindingId) : undefined
  const providerId = notice.providerId ?? turn?.providerId
  if (!providerId) return undefined
  return sessionAttentionKey({
    providerId, agentProfileId: notice.agentProfileId ?? binding?.agentProfileId,
    cwd: page.summary.cwd, sessionId: notice.sessionId
  })
}

type ViewSessions = (request: { viewId: string; main: boolean; sessionKeys: string[] }) => Promise<boolean>

/**
 * What one conversation view tells main it shows: the page's sessions and those its
 * runs just announced. Sends only when that set changes, and withdraws it on dispose.
 */
export class ViewedSessions {
  #page: ViewedPage | undefined
  #announced: string[] = []
  #sent = '[]'
  readonly #viewId: string

  constructor(private readonly view: ViewSessions, conversationId: string, private readonly main: boolean) {
    this.#viewId = `${main ? 'main' : 'side'}:${conversationId}`
  }

  setPage(page: ViewedPage | undefined): void {
    this.#page = page
    this.#publish()
  }

  notice(notice: SessionNotice): void {
    const key = noticeSessionKey(this.#page, notice)
    if (!key || this.#announced.includes(key)) return
    this.#announced = [key, ...this.#announced].slice(0, MAX_KEYS)
    this.#publish()
  }

  dispose(): void {
    if (this.#sent !== '[]') this.#send([])
    this.#sent = '[]'
  }

  #publish(): void {
    const keys = [...new Set([...this.#announced, ...conversationSessionKeys(this.#page)])].slice(0, MAX_KEYS)
    const signature = JSON.stringify(keys)
    if (signature === this.#sent) return
    this.#sent = signature
    this.#send(keys)
  }

  #send(sessionKeys: string[]): void {
    void this.view({ viewId: this.#viewId, main: this.main, sessionKeys }).catch(() => undefined)
  }
}

/**
 * Names the page's sessions as viewed while it is mounted; `main` when it fills the main
 * pane rather than sitting beside a session. Main clears them again when the window
 * regains focus, so nothing here listens for focus.
 */
export function useConversationSessionsViewed(conversationId: string, main: boolean, page: ViewedPage | undefined): void {
  const [viewed, setViewed] = useState<ViewedSessions>()
  useEffect(() => {
    const view = window.scry.viewSessions
    if (!view) return
    const next = new ViewedSessions(view, conversationId, main)
    setViewed(next)
    const off = window.scry.onSession?.((notice) => next.notice(notice))
    return () => { off?.(); next.dispose(); setViewed(undefined) }
  }, [conversationId, main])
  useEffect(() => { viewed?.setPage(page) }, [viewed, page])
}
