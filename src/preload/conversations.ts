import { ipcRenderer } from 'electron'
import type { ConversationApi } from '../shared/conversation-api'

/**
 * Typed, fixed conversation operations. Side-chat creation is local-only; no
 * Provider call happens until the first send of the new child.
 */
export const conversationsApi = {
  create: (cwd: string): ReturnType<ConversationApi['create']> => ipcRenderer.invoke('conversation:create', cwd),
  fork: (request: Parameters<ConversationApi['fork']>[0]): ReturnType<ConversationApi['fork']> => ipcRenderer.invoke('conversation:fork', request),
  previewAdoption: (...args: Parameters<ConversationApi['previewAdoption']>): ReturnType<ConversationApi['previewAdoption']> => ipcRenderer.invoke('conversation:previewAdoption', ...args),
  adopt: (source: Parameters<ConversationApi['adopt']>[0], fingerprint: string): ReturnType<ConversationApi['adopt']> => ipcRenderer.invoke('conversation:adopt', source, fingerprint),
  previewDeletion: (id: string): ReturnType<ConversationApi['previewDeletion']> => ipcRenderer.invoke('conversation:previewDeletion', id),
  delete: (id: string, fingerprint: string): ReturnType<ConversationApi['delete']> => ipcRenderer.invoke('conversation:delete', id, fingerprint),
  update: (id: string, revision: number, change: Parameters<ConversationApi['update']>[2]): ReturnType<ConversationApi['update']> => ipcRenderer.invoke('conversation:update', id, revision, change),
  list: (cwd: string): ReturnType<ConversationApi['list']> => ipcRenderer.invoke('conversation:list', cwd),
  read: (id: string, beforeOrdinal?: number): ReturnType<ConversationApi['read']> => ipcRenderer.invoke('conversation:read', id, beforeOrdinal),
  readItem: (id: string, ref: Parameters<ConversationApi['readItem']>[1]): ReturnType<ConversationApi['readItem']> => ipcRenderer.invoke('conversation:readItem', id, ref),
  preview: (id: string, request: Parameters<ConversationApi['preview']>[1]): ReturnType<ConversationApi['preview']> => ipcRenderer.invoke('conversation:preview', id, request),
  send: (request: Parameters<ConversationApi['send']>[0]): ReturnType<ConversationApi['send']> => ipcRenderer.invoke('conversation:send', request),
  previewSideChat: (...args: Parameters<ConversationApi['previewSideChat']>): ReturnType<ConversationApi['previewSideChat']> => ipcRenderer.invoke('conversation:previewSideChat', ...args),
  createSideChat: (request: Parameters<ConversationApi['createSideChat']>[0]): ReturnType<ConversationApi['createSideChat']> => ipcRenderer.invoke('conversation:createSideChat', request),
  listSideChats: (request: Parameters<ConversationApi['listSideChats']>[0]): ReturnType<ConversationApi['listSideChats']> => ipcRenderer.invoke('conversation:listSideChats', request),
  findSideChatCommand: (...args: Parameters<ConversationApi['findSideChatCommand']>): ReturnType<ConversationApi['findSideChatCommand']> => ipcRenderer.invoke('conversation:findSideChatCommand', ...args),
  readSideChatSnapshot: (...args: Parameters<ConversationApi['readSideChatSnapshot']>): ReturnType<ConversationApi['readSideChatSnapshot']> => ipcRenderer.invoke('conversation:readSideChatSnapshot', ...args)
} satisfies ConversationApi
