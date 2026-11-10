import type { DaemonForwardEntry, DaemonForwardTable, DaemonLocalOpTable } from './types'
import { DESKTOP_WORKBENCH_METHODS, DESKTOP_WORKBENCH_READ_METHODS, type DesktopWorkbenchRequest } from '../../shared/desktop-workbench'
import { validateDesktopWorkbenchResponse } from '../remote/desktop-workbench-response'
import { object, text } from '../source-control/ipc'

// Workbench: workspace files and source control, forwarded to the `desktopWorkbench` op
// the daemon's host already serves paired devices. The daemon authorizes the workspace on
// every call (known project, canonical path, repository identity); this side only binds
// each request to what main's in-process handler was bound to, so the forward is never
// wider than that handler.
//
// Left out on purpose, so the gate refuses them by name:
//   workspace:openExternal, workspace:trash - the daemon has no shell to open or trash
//     with (its host reports workbenchOps openPath/trashItem false);
//   terminal:* - output is pushed to the window in process but polled on this op, and the
//     PTYs would live in the daemon past the window. Both need a design decision.
export const WORKBENCH_LOCAL_OPS: DaemonLocalOpTable = {}

let windowCwd: () => string | undefined = () => undefined
// Repository id -> the directory this window read it from. Only a route: the daemon
// re-reads that directory and refuses an id that is not its repository, so a stale or
// forged entry cannot reach another repository. Bounded like any in-memory cache.
const MAX_REPOSITORIES = 64
const repositoryCwds = new Map<string, string>()

/**
 * The window's workspace selection (agent:setCwd, kept in main), which every in-process
 * workspace handler requires the request to name. Installing a new source starts with no
 * remembered repositories.
 */
export function installWorkbenchWindowCwd(next: () => string | undefined): () => void {
  windowCwd = next
  repositoryCwds.clear()
  return () => {
    if (windowCwd !== next) return
    windowCwd = () => undefined
    repositoryCwds.clear()
  }
}

function rememberRepository(id: string, cwd: string): void {
  repositoryCwds.delete(id)
  repositoryCwds.set(id, cwd)
  if (repositoryCwds.size > MAX_REPOSITORIES) repositoryCwds.delete(repositoryCwds.keys().next().value!)
}

function workbenchResult(query: DesktopWorkbenchRequest, reply: Record<string, unknown>): unknown {
  if (!Object.hasOwn(reply, 'workbench')) throw new Error('invalid_desktop_workbench_response')
  validateDesktopWorkbenchResponse(query, reply.workbench)
  return reply.workbench
}

type Surface = 'workspace' | 'sourceControl'
type Method<S extends Surface> = (typeof DESKTOP_WORKBENCH_METHODS)[S][number]

function forward<S extends Surface>(surface: S, method: Method<S>, cwd: (args: unknown[]) => string, after?: (value: unknown, args: unknown[]) => unknown): DaemonForwardEntry {
  return {
    op: 'desktopWorkbench',
    read: DESKTOP_WORKBENCH_READ_METHODS.has(method),
    // main's handlers take exactly one request; anything after it never reached them.
    request: (args) => ({ op: 'desktopWorkbench', query: { surface, cwd: cwd(args), method, args: [args[0]] } }),
    result: (reply, args) => {
      // The reply's shape depends on surface and method only. The cwd is not looked up
      // again: a selection that changed while a write was in flight must not turn its
      // completed result into a refusal.
      const value = workbenchResult({ surface, cwd: '', method, args: [args[0]] } as DesktopWorkbenchRequest, reply)
      return after ? after(value, args) : value
    }
  }
}

// In process: authorizedWorkspaceRequest(currentCwd, request). The daemon compares the
// request's canonical cwd with this one and refuses a mismatch, so the window's selection
// stays the only workspace these channels reach.
function windowWorkspace(): string {
  const cwd = windowCwd()
  if (!cwd) throw new Error('未授权工作区文件访问')
  return cwd
}

// In process the service resolves a repository id it read earlier; one it never read is
// the same refusal here, raised before anything is sent.
function readRepository(args: unknown[]): string {
  const cwd = repositoryCwds.get(text(object(args[0]).repositoryId, 64))
  if (!cwd) throw new Error('仓库引用已过期，请重新读取工作区')
  return cwd
}

const workspace = (method: Method<'workspace'>) => forward('workspace', method, windowWorkspace)
const sourceControl = (method: Method<'sourceControl'>, after?: (value: unknown) => unknown) =>
  forward('sourceControl', method, readRepository, after)
// main's save handlers resolve with nothing; the wire carries that as null.
const nothing = (): undefined => undefined

export const WORKBENCH_FORWARDS: DaemonForwardTable = {
  'workspace:list': workspace('workspaceList'),
  'workspace:read': workspace('workspaceRead'),
  'workspace:readPage': workspace('workspaceReadPage'),
  'workspace:write': workspace('workspaceWrite'),
  'workspace:create': workspace('workspaceCreate'),
  'workspace:rename': workspace('workspaceRename'),
  'workspace:move': workspace('workspaceMove'),
  // Source control is not bound to the window's selection in process either: read names
  // its directory, the rest name a repository that read returned.
  'sourceControl:read': forward('sourceControl', 'read', (args) => text(args[0]), (value, args) => {
    const read = value as { status?: unknown; data?: { id?: unknown } }
    if (read.status === 'available' && typeof read.data?.id === 'string') rememberRepository(read.data.id, text(args[0]))
    return value
  }),
  'sourceControl:diff': sourceControl('diff'),
  'sourceControl:mutate': sourceControl('mutate'),
  'sourceControl:operations': sourceControl('operations'),
  'sourceControl:reconcile': sourceControl('reconcile'),
  'sourceControl:acknowledge': sourceControl('acknowledge'),
  'sourceControl:pullRequests': sourceControl('pullRequests'),
  'sourceControl:pullRequest': sourceControl('pullRequest'),
  'sourceControl:saveCommitDraft': sourceControl('saveCommitDraft', nothing),
  'sourceControl:loadCommitDraft': sourceControl('loadCommitDraft'),
  'sourceControl:saveDraft': sourceControl('saveDraft', nothing),
  'sourceControl:loadDraft': sourceControl('loadDraft')
}
