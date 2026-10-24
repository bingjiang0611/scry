import { shell } from 'electron'
import { isAbsolute } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'

export interface ProjectHandlersDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  projectStore: () => { setPinned: (cwd: string, pinned: boolean) => boolean; rename: (cwd: string, name: string) => boolean; remove: (cwd: string) => void }
  recentStore: () => { remove: (cwd: string) => void }
}

export function registerProjectHandlers(deps: ProjectHandlersDependencies): void {
  const { handleTrusted, projectStore, recentStore } = deps
  const projectCwdFromRequest = (value: unknown): string => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error('无效的项目目录')
    return value
  }

  handleTrusted('agent:setProjectPinned', (_event, cwd: unknown, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new Error('无效的项目置顶请求')
    return projectStore().setPinned(projectCwdFromRequest(cwd), pinned)
  })

  handleTrusted('agent:renameProject', (_event, cwd: unknown, name: unknown) => {
    const label = typeof name === 'string' ? name.trim() : ''
    if (!label || label.length > 120) throw new Error('项目名称必须为 1–120 个字符')
    return projectStore().rename(projectCwdFromRequest(cwd), label)
  })

  handleTrusted('agent:removeProject', (_event, cwd: unknown) => {
    const dir = projectCwdFromRequest(cwd)
    projectStore().remove(dir)
    recentStore().remove(dir)
    return true as const
  })

  handleTrusted('agent:revealProject', (_event, cwd: unknown) => {
    shell.showItemInFolder(projectCwdFromRequest(cwd))
    return true as const
  })

  // 加载一个历史会话：解析 transcript 成对话轮次，并把它设为当前会话（后续对话会 resume）

}
