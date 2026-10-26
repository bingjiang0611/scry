// 「项目 / 动态」是 Sidebar 的组件本地状态。renderer 进程崩溃后主进程会静默重载窗口，
// 重载会把 tab 打回默认值，让用户看起来"自己跳到了项目 tab"。这里把当前 tab 持久化，
// 使重载后的侧栏回到用户离开时的位置。
export type SidebarView = 'projects' | 'activity'

export const SIDEBAR_VIEW_STORAGE_KEY = 'scry.sidebar-view.v1'

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

export function normalizeSidebarView(value: unknown): SidebarView {
  return value === 'activity' ? 'activity' : 'projects'
}

export function readStoredSidebarView(storage: StorageReader | undefined): SidebarView {
  try {
    return normalizeSidebarView(storage?.getItem(SIDEBAR_VIEW_STORAGE_KEY))
  } catch {
    return 'projects'
  }
}

export function persistSidebarView(view: SidebarView, storage: StorageWriter | undefined): void {
  try {
    storage?.setItem(SIDEBAR_VIEW_STORAGE_KEY, view)
  } catch {
    // 存储不可用时只保留进程内记忆，切换 tab 本身不需要失败。
  }
}
