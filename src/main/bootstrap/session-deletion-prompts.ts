import type { DeleteSessionResult } from '../../shared/provider'

// What the user is asked and told when a session, or every archived session, is deleted.
// Free of Electron so main's dialogs and the daemon-mode App ask with the same words.

export const ARCHIVED_DELETION_DETAIL = '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'

/** A deletion that did nothing: what was never touched, by design, is still named. */
export function untouchedDeletion(): Pick<DeleteSessionResult, 'deleted' | 'retained' | 'failed'> {
  return {
    deleted: [],
    retained: ['workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history'],
    failed: []
  }
}

export const SESSION_DELETION_PROMPT = {
  message: '删除这个历史会话？',
  button: '删除 Scry 会话副本',
  detail: ARCHIVED_DELETION_DETAIL
}

/** The single-session prompt, naming the side chats the deletion takes along. */
export function sessionDeletionPrompt(sideChatCount = 0) {
  return sideChatCount > 0
    ? { ...SESSION_DELETION_PROMPT, detail: `${SESSION_DELETION_PROMPT.detail}\n这个会话的 ${sideChatCount} 个侧边会话会一并删除。` }
    : SESSION_DELETION_PROMPT
}

export function archivedDeletionPrompt(count: number) {
  return {
    message: `永久删除全部 ${count} 个已存档会话？`, button: `删除全部 ${count} 个`,
    detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录，以及这些会话各自的侧边会话。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'
  }
}
