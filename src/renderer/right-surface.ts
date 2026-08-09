export const RIGHT_SURFACE_KINDS = ['overview', 'files', 'diff', 'terminal', 'agents'] as const

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

export const RIGHT_SURFACE_BY_KIND: Readonly<Record<RightSurfaceKind, RightSurfaceDefinition>> =
  Object.fromEntries(RIGHT_SURFACE_DEFINITIONS.map((definition) => [definition.kind, definition])) as Record<
    RightSurfaceKind,
    RightSurfaceDefinition
  >

export interface RightSurfaceState {
  openIds: RightSurfaceKind[]
  activeId: RightSurfaceKind | null
  visible: boolean
  maximized: boolean
}

export interface CreateRightSurfaceStateOptions {
  openIds?: readonly RightSurfaceKind[]
  activeId?: RightSurfaceKind | null
  visible?: boolean
  maximized?: boolean
}

export type RightSurfaceAction =
  | { type: 'open'; kind: RightSurfaceKind }
  | { type: 'activate'; kind: RightSurfaceKind }
  | { type: 'close'; kind: RightSurfaceKind }
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'toggle-maximized' }
  | { type: 'set-maximized'; maximized: boolean }

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

  return {
    openIds,
    activeId,
    visible,
    maximized: visible ? (options.maximized ?? false) : false
  }
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
      if (alreadyOpen && state.activeId === action.kind && state.visible) return state
      return {
        ...state,
        openIds: alreadyOpen ? state.openIds : [...state.openIds, action.kind],
        activeId: action.kind,
        visible: true
      }
    }
    case 'activate': {
      if (!state.openIds.includes(action.kind) || state.activeId === action.kind) return state
      return { ...state, activeId: action.kind }
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
