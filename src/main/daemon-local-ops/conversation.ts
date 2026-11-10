import type { DaemonLocalOpTable } from './types'

// Unified conversation ledger (B4-L4-2).
export const CONVERSATION_LOCAL_OPS: DaemonLocalOpTable = {
  // Conversation ledger reads (B4-L4-2a). previewSideChat streams the source prefix into
  // a capture manifest, so it is not replayed after a lost reply.
  'conversation:list': { op: 'conversation', method: 'list', read: true },
  'conversation:read': { op: 'conversation', method: 'read', read: true },
  'conversation:readItem': { op: 'conversation', method: 'readItem', read: true },
  'conversation:preview': { op: 'conversation', method: 'preview', read: true },
  'conversation:previewAdoption': { op: 'conversation', method: 'previewAdoption', read: true },
  'conversation:previewDeletion': { op: 'conversation', method: 'previewDeletion', read: true },
  'conversation:previewSideChat': { op: 'conversation', method: 'previewSideChat', read: false },
  'conversation:listSideChats': { op: 'conversation', method: 'listSideChats', read: true },
  'conversation:findSideChatCommand': { op: 'conversation', method: 'findSideChatCommand', read: true },
  'conversation:readSideChatSnapshot': { op: 'conversation', method: 'readSideChatSnapshot', read: true },
  // Conversation ledger writes the daemon makes on its own (B4-L4-2b). Never replayed after
  // a lost reply. fork (Provider fork) stays refused until session fork moves.
  'conversation:create': { op: 'conversation', method: 'create', read: false },
  'conversation:update': { op: 'conversation', method: 'update', read: false },
  'conversation:adopt': { op: 'conversation', method: 'adopt', read: false },
  'conversation:createSideChat': { op: 'conversation', method: 'createSideChat', read: false },
  // The send runs through the daemon's ledger so the App follows it like its own runs
  // (P3-conversation-send.md). Its commandId makes a retry safe, but a lost reply is
  // still not replayed: the App asks the conversation instead.
  'conversation:send': { op: 'conversation', method: 'send', read: false },
  // Deletes the conversation's sessions through the daemon's session lifecycle. The
  // renderer previews and confirms (ConversationDeleteDialog); the fingerprint it confirmed
  // must still match, or nothing is cleaned.
  'conversation:delete': { op: 'conversation', method: 'delete', read: false }
}
