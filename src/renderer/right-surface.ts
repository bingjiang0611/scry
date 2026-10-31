export const RIGHT_SURFACE_KINDS = ['overview', 'files', 'diff', 'source-control', 'terminal', 'agents'] as const

export type RightSurfaceKind = (typeof RIGHT_SURFACE_KINDS)[number]

export interface RightSurfaceDefinition {
  kind: RightSurfaceKind
  label: string
  description: string
  icon: 'overview' | 'folder' | 'diff' | 'terminal' | 'agents'
}

export const RIGHT_SURFACE_DEFINITIONS: readonly RightSurfaceDefinition[] = [
  {
    kind: 'overview',
    label: '纵览',
    description: '查看当前会话的结论、调用与证据。',
    icon: 'overview'
  },
  {
    kind: 'files',
    label: '文件',
    description: '浏览、阅读并引用工作区文件。',
    icon: 'folder'
  },
  {
    kind: 'diff',
    label: 'Diff',
    description: '审阅当前任务产生的代码改动。',
    icon: 'diff'
  },
  {
    kind: 'source-control',
    label: '源代码管理',
    description: '查看真实 Git 暂存区，提交、推送并审查 GitHub PR。',
    icon: 'diff'
  },
  {
    kind: 'terminal',
    label: '终端',
    description: '启动本机 Shell；未绑定时从用户主目录开始。',
    icon: 'terminal'
  },
  {
    kind: 'agents',
    label: 'Agents',
    description: '查看子 Agent 的状态、活动与工具调用。',
    icon: 'agents'
  }
]

/**
 * One item in the flat tab strip: a tool surface or one side-chat instance.
 *
 * Tools are singletons per conversation; side chats are instances, so they carry their
 * child conversation id. Both live on the same level and share one active tab.
 */
export type RightSurfaceTab =
  | { type: 'tool'; kind: RightSurfaceKind }
  | { type: 'side-chat'; conversationId: string }

/** Display bound of the tab strip; children themselves are never deleted by it. */
export const MAX_SIDE_CHAT_TABS = 8

export interface RightSurfaceState {
  openIds: RightSurfaceKind[]
  /** Last active tool; `activeSideChatId` overrides it while a child tab is active. */
  activeId: RightSurfaceKind | null
  visible: boolean
  maximized: boolean
  /** Open side-chat instances of this scope, ordered after the tool tabs. */
  sideChats: string[]
  /** The active child tab, or null when a tool (or the chooser) is active. */
  activeSideChatId: string | null
}

export interface CreateRightSurfaceStateOptions {
  openIds?: readonly RightSurfaceKind[]
  activeId?: RightSurfaceKind | null
  visible?: boolean
  maximized?: boolean
  sideChats?: readonly string[]
  activeSideChatId?: string | null
}

export type RightSurfaceAction =
  | { type: 'open'; kind: RightSurfaceKind }
  | { type: 'activate'; kind: RightSurfaceKind }
  | { type: 'close'; kind: RightSurfaceKind }
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'toggle-maximized' }
  | { type: 'set-maximized'; maximized: boolean }
  | { type: 'open-side-chat'; conversationId: string }
  | { type: 'activate-side-chat'; conversationId: string }
  /** Closes the view only. The child keeps running and its record is untouched. */
  | { type: 'close-side-chat'; conversationId: string }
  /** Drops ids a bounded summary read proved deleted; unknown ids stay open. */
  | { type: 'drop-side-chats'; conversationIds: readonly string[] }

function uniqueKinds(kinds: readonly RightSurfaceKind[]): RightSurfaceKind[] {
  return kinds.filter((kind, index) => kinds.indexOf(kind) === index)
}

export function createRightSurfaceState(options: CreateRightSurfaceStateOptions = {}): RightSurfaceState {
  const openIds = uniqueKinds(options.openIds ?? ['overview'])
  const requestedActive = options.activeId
  const activeId = requestedActive && openIds.includes(requestedActive)
    ? requestedActive
    : openIds[0] ?? null
  const visible = options.visible ?? true

  const sideChats = (options.sideChats ?? []).filter(
    (id, index, all) => Boolean(id) && all.indexOf(id) === index).slice(-MAX_SIDE_CHAT_TABS)
  const requestedSideChat = options.activeSideChatId
  return {
    openIds,
    activeId,
    visible,
    maximized: visible ? (options.maximized ?? false) : false,
    sideChats,
    activeSideChatId: requestedSideChat && sideChats.includes(requestedSideChat) ? requestedSideChat : null
  }
}

/** Active tool tab; a child tab being active means no tool is. */
export function activeToolId(state: RightSurfaceState): RightSurfaceKind | null {
  return state.activeSideChatId ? null : state.activeId
}

/** Flat tab order: tool tabs first, then side-chat instances in their open order. */
export function rightSurfaceTabs(state: RightSurfaceState): RightSurfaceTab[] {
  return [
    ...state.openIds.map((kind): RightSurfaceTab => ({ type: 'tool', kind })),
    ...state.sideChats.map((conversationId): RightSurfaceTab => ({ type: 'side-chat', conversationId }))
  ]
}

export function rightSurfaceTabKey(tab: RightSurfaceTab): string {
  return tab.type === 'tool' ? tab.kind : `side-chat:${tab.conversationId}`
}

export function activeRightSurfaceTabKey(state: RightSurfaceState): string | null {
  if (state.activeSideChatId) return `side-chat:${state.activeSideChatId}`
  return state.activeId
}

/** Nothing open means the chooser is the view, not an empty workbench. */
export function rightSurfaceIsChooser(state: RightSurfaceState): boolean {
  return state.openIds.length === 0 && state.sideChats.length === 0
}

function activeKindAfterClose(
  openIds: readonly RightSurfaceKind[],
  activeId: RightSurfaceKind | null,
  closingKind: RightSurfaceKind
): RightSurfaceKind | null {
  if (activeId !== closingKind) return activeId

  const closingIndex = openIds.indexOf(closingKind)
  if (closingIndex < 0) return activeId

  return openIds[closingIndex + 1] ?? openIds[closingIndex - 1] ?? null
}

/**
 * Pure state transition for the right-hand workbench. Keeping this outside React
 * makes close-neighbour selection and visibility/maximize invariants testable.
 */
export function reduceRightSurfaceState(state: RightSurfaceState, action: RightSurfaceAction): RightSurfaceState {
  switch (action.type) {
    case 'open': {
      const alreadyOpen = state.openIds.includes(action.kind)
      if (alreadyOpen && state.activeId === action.kind && state.visible && !state.activeSideChatId) return state
      return {
        ...state,
        openIds: alreadyOpen ? state.openIds : [...state.openIds, action.kind],
        activeId: action.kind,
        visible: true,
        activeSideChatId: null
      }
    }
    case 'activate': {
      if (!state.openIds.includes(action.kind)) return state
      if (state.activeId === action.kind && !state.activeSideChatId) return state
      return { ...state, activeId: action.kind, activeSideChatId: null }
    }
    case 'open-side-chat': {
      const open = state.sideChats.includes(action.conversationId)
      if (open && state.activeSideChatId === action.conversationId && state.visible) return state
      // A new instance opens at the end; the list keeps at most eight views. The child
      // record is durable, so dropping an older tab here deletes no conversation.
      const sideChats = open ? state.sideChats : [...state.sideChats, action.conversationId].slice(-MAX_SIDE_CHAT_TABS)
      return { ...state, sideChats, activeSideChatId: action.conversationId, visible: true }
    }
    case 'activate-side-chat': {
      if (!state.sideChats.includes(action.conversationId) || state.activeSideChatId === action.conversationId) return state
      return { ...state, activeSideChatId: action.conversationId }
    }
    case 'close-side-chat': {
      const index = state.sideChats.indexOf(action.conversationId)
      if (index < 0) return state
      const sideChats = state.sideChats.filter((id) => id !== action.conversationId)
      if (state.activeSideChatId !== action.conversationId) return { ...state, sideChats }
      // Neighbour first, then the last tool, then the chooser.
      const neighbour = sideChats[index] ?? sideChats[index - 1] ?? null
      return { ...state, sideChats, activeSideChatId: neighbour }
    }
    case 'drop-side-chats': {
      const dropped = new Set(action.conversationIds)
      if (!state.sideChats.some((id) => dropped.has(id))) return state
      const sideChats = state.sideChats.filter((id) => !dropped.has(id))
      return {
        ...state,
        sideChats,
        activeSideChatId: state.activeSideChatId && dropped.has(state.activeSideChatId)
          ? sideChats.at(-1) ?? null
          : state.activeSideChatId
      }
    }
    case 'close': {
      if (!state.openIds.includes(action.kind)) return state
      const activeId = activeKindAfterClose(state.openIds, state.activeId, action.kind)
      return {
        ...state,
        openIds: state.openIds.filter((kind) => kind !== action.kind),
        activeId
      }
    }
    case 'show': {
      if (state.visible) return state
      return {
        ...state,
        visible: true,
        activeId: state.activeId ?? state.openIds[0] ?? null
      }
    }
    case 'hide': {
      if (!state.visible && !state.maximized) return state
      return { ...state, visible: false, maximized: false }
    }
    case 'toggle-maximized':
      return { ...state, visible: true, maximized: !state.maximized }
    case 'set-maximized': {
      if (state.maximized === action.maximized && (state.visible || !action.maximized)) return state
      return { ...state, visible: action.maximized ? true : state.visible, maximized: action.maximized }
    }
  }
}
