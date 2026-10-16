import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DESKTOP_WORKBENCH_METHODS, type DesktopTerminalEvent, type DesktopTerminalEvents } from '../../shared/desktop-workbench'
import { TERMINAL_MAX_DIMENSION, TERMINAL_MAX_INPUT_BYTES } from '../../shared/terminal'
import type { WorkspaceFilePageRequest, WorkspaceListRequest } from '../../shared/workspace'
import { createTerminalManager, type TerminalManager, type TerminalPtyFactory } from '../terminal-manager'
import { TerminalOutputBridge } from '../terminal-output'
import { sourceControlHandlers } from '../source-control/ipc'
import type { SourceControlService } from '../source-control/service'
import {
  createWorkspaceEntry, listWorkspace, moveWorkspaceEntry, openWorkspaceFileExternally,
  readWorkspaceFile, readWorkspaceFilePage, renameWorkspaceEntry, trashWorkspaceEntry, writeWorkspaceFile
} from '../workspace-files'

export interface DesktopWorkbenchQuery {
  surface: keyof typeof DESKTOP_WORKBENCH_METHODS
  cwd: string
  method: string
  args: unknown[]
}
export interface DesktopWorkbenchHost {
  request(peer: string, query: DesktopWorkbenchQuery, authorizePeer: () => void): Promise<unknown>
  release(peer: string): Promise<void>
  dispose(): Promise<void>
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_workbench_request')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || value.includes('\0')) throw new Error('invalid_workbench_request')
  return value
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('invalid_workbench_request')
  return value as number
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value, 4096, true) }
function optionalInteger(value: unknown, min: number, max?: number): number | undefined {
  return value === undefined ? undefined : integer(value, min, max)
}
export function parseDesktopWorkbenchQuery(value: unknown): DesktopWorkbenchQuery {
  const input = object(value)
  const cwd = text(input.cwd)
  const surface = input.surface
  if (surface !== 'workspace' && surface !== 'sourceControl' && surface !== 'terminal') throw new Error('invalid_workbench_surface')
  const method = text(input.method, 64)
  if (!(DESKTOP_WORKBENCH_METHODS[surface] as readonly string[]).includes(method) || !Array.isArray(input.args) || input.args.length > 4) throw new Error('invalid_workbench_method')
  return { surface, cwd, method, args: input.args }
}

interface TerminalScope {
  manager: TerminalManager
  output: TerminalOutputBridge
  sequence: number
  streamId: string
  acknowledged: Map<string, number>
  events: Array<{ cursor: number; event: DesktopTerminalEvent }>
}

export function createDesktopWorkbench(deps: {
  directory: string
  authorizeWorkspace(cwd: string): string
  sourceControl: SourceControlService
  environment(): Promise<Record<string, string | undefined>>
  openPath(path: string): Promise<void>
  trashItem(path: string): Promise<void>
  pty?: TerminalPtyFactory
}): DesktopWorkbenchHost {
  const scopes = new Map<string, Map<string, Promise<TerminalScope>>>()
  let disposed = false
  const authorize = (cwd: string): string => {
    if (disposed) throw new Error('desktop_workbench_closed')
    return deps.authorizeWorkspace(cwd)
  }
  const terminalScope = (peer: string, cwd: string): Promise<TerminalScope> => {
    let owned = scopes.get(peer)
    if (!owned) { owned = new Map(); scopes.set(peer, owned) }
    let pending = owned.get(cwd)
    if (!pending) {
      pending = deps.environment().then((env) => {
        authorize(cwd)
        const events: TerminalScope['events'] = []
        let sequence = 0
        const enqueue = (event: DesktopTerminalEvent): void => { events.push({ cursor: ++sequence, event }) }
        let manager: TerminalManager
        const output = new TerminalOutputBridge({
          canSend: () => !disposed,
          sendData: (data) => enqueue({ kind: 'data', events: data }),
          sendExit: (event) => enqueue({ kind: 'exit', event }),
          pauseTerminal: (id) => manager.pauseOutput(id),
          resumeTerminal: (id) => manager.resumeOutput(id),
          flushBytes: 32 * 1024,
          highWaterBytes: 256 * 1024,
          maxBufferBytes: 1024 * 1024
        })
        // A separate manager binds this peer's PTYs to one canonical workspace.
        // Host-local shells and another certificate's shells are never attachable.
        manager = createTerminalManager({
          getCurrentCwd: () => authorize(cwd), defaultCwd: cwd, env, shell: env.SHELL,
          pty: deps.pty,
          recordingDirectory: join(deps.directory, peer, createHash('sha256').update(cwd).digest('hex')),
          onData: (event) => output.data(event), onExit: (event) => output.exit(event),
          onRecordingError: (event) => enqueue({ kind: 'recordingError', event })
        })
        return { manager, output, events, streamId: randomUUID(), acknowledged: new Map(), get sequence() { return sequence } }
      })
      owned.set(cwd, pending)
      void pending.catch(() => { if (owned?.get(cwd) === pending) owned.delete(cwd) })
    }
    return pending
  }
  const release = async (peer: string): Promise<void> => {
    const owned = scopes.get(peer)
    scopes.delete(peer)
    if (!owned) return
    await Promise.all([...owned.values()].map(async (pending) => {
      const scope = await pending
      scope.output.close()
      await scope.manager.shutdown()
    }))
  }

  return {
    async request(peer, query, authorizePeer) {
      const authorizeRequest = (): void => { authorizePeer(); authorize(query.cwd) }
      authorizeRequest()
      const cwd = authorize(query.cwd)
      const source = sourceControlHandlers(deps.sourceControl, authorizeRequest)
      const { args, method } = query
      let result: unknown
      if (query.surface === 'workspace') {
        if (args.length !== 1) throw new Error('invalid_workbench_request')
        const input = object(args[0])
        if (authorize(text(input.cwd)) !== cwd) throw new Error('workspace_context_mismatch')
        const path = optionalText(input.path) ?? ''
        const request = { cwd, path }
        switch (method) {
          case 'workspaceList': {
            const list: WorkspaceListRequest = { ...request, cursor: optionalText(input.cursor), limit: optionalInteger(input.limit, 1, 200) }
            result = await listWorkspace(list); break
          }
          case 'workspaceRead':
          case 'workspaceReadKnown': {
            const file = await readWorkspaceFile(request)
            if (Buffer.byteLength(JSON.stringify(file)) > 3 * 1024 * 1024) throw new Error('文件较大，请使用分页只读视图')
            result = file; break
          }
          case 'workspaceReadPage':
          case 'workspaceReadPageKnown': {
            const page: WorkspaceFilePageRequest = { ...request, offset: optionalInteger(input.offset, 0), limit: optionalInteger(input.limit, 1, 64 * 1024), snapshot: optionalText(input.snapshot) }
            result = await readWorkspaceFilePage(page); break
          }
          case 'workspaceOpenExternal':
          case 'workspaceOpenKnownExternal': result = await openWorkspaceFileExternally(request, async (path) => { authorizeRequest(); await deps.openPath(path) }); break
          case 'workspaceWrite':
            result = await writeWorkspaceFile({ ...request, content: text(input.content, 1024 * 1024, true), expectedRevision: text(input.expectedRevision, 64) }, authorizeRequest); break
          case 'workspaceCreate': {
            if (input.kind !== 'file' && input.kind !== 'directory') throw new Error('invalid_workspace_kind')
            result = await createWorkspaceEntry({ cwd, parentPath: optionalText(input.parentPath), name: text(input.name, 512), kind: input.kind }, authorizeRequest); break
          }
          case 'workspaceRename': result = await renameWorkspaceEntry({ ...request, name: text(input.name, 512) }, authorizeRequest); break
          case 'workspaceMove': result = await moveWorkspaceEntry({ ...request, parentPath: optionalText(input.parentPath) }, authorizeRequest); break
          case 'workspaceTrash': result = await trashWorkspaceEntry(request, async (path) => { authorizeRequest(); await deps.trashItem(path) }); break
          default: throw new Error('invalid_workbench_method')
        }
      } else if (query.surface === 'sourceControl') {
        if (args.length !== 1) throw new Error('invalid_workbench_request')
        if (method === 'read') {
          if (authorize(text(args[0])) !== cwd) throw new Error('workspace_context_mismatch')
        } else {
          // Repository IDs are references, not grants. Bind every request back to
          // the selected host workspace before using the canonical service gate.
          const ref = object(args[0])
          const repository = await deps.sourceControl.read(cwd)
          if (repository.status !== 'available' || repository.data.id !== text(ref.repositoryId, 64)) throw new Error('repository_context_mismatch')
          authorizeRequest()
        }
        if (!Object.hasOwn(source, method)) throw new Error('invalid_workbench_method')
        result = await source[method as keyof typeof source](args[0])
      } else {
        const scope = await terminalScope(peer, cwd)
        authorizeRequest()
        const { manager, output } = scope
        if (method === 'terminalStart') {
          if (args.length !== 1) throw new Error('invalid_workbench_request')
          const input = object(args[0])
          if (authorize(text(input.cwd)) !== cwd) throw new Error('workspace_context_mismatch')
          const session = manager.start({ cwd, cols: integer(input.cols, 1, TERMINAL_MAX_DIMENSION), rows: integer(input.rows, 1, TERMINAL_MAX_DIMENSION), scopeId: input.scopeId === undefined ? undefined : text(input.scopeId, 128) })
          result = { ...session, ownershipEpoch: output.started(session.id) }
        } else if (method === 'terminalActive') {
          if (args.length) throw new Error('invalid_workbench_request')
          result = manager.activeSessions()
        } else if (method === 'terminalEvents') {
          if (args.length > 1) throw new Error('invalid_workbench_request')
          const token = args[0] === undefined ? undefined : text(args[0], 128)
          const [streamId, position] = token?.split(':') ?? []
          const cursor = streamId === scope.streamId ? integer(Number(position), 0, scope.sequence) : 0
          scope.events.splice(0, scope.events.length, ...scope.events.filter((event) => event.cursor > cursor))
          const page: DesktopTerminalEvents = { cursor: `${scope.streamId}:${cursor}`, events: [] }
          let bytes = 0
          for (const row of scope.events) {
            const size = Buffer.byteLength(JSON.stringify(row))
            if (bytes + size > 512 * 1024 && page.events.length) break
            page.events.push(row.event); page.cursor = `${scope.streamId}:${row.cursor}`; bytes += size
          }
          result = page
        } else if (method === 'terminalRecordingList') {
          if (args.length > 1) throw new Error('invalid_workbench_request')
          const input = args[0] === undefined ? {} : object(args[0])
          result = await manager.listRecordings({ after: optionalText(input.after), limit: optionalInteger(input.limit, 1, 100) })
        } else if (method === 'terminalRecordingRead') {
          if (args.length !== 1) throw new Error('invalid_workbench_request')
          const input = object(args[0])
          result = await manager.readRecording({ id: text(input.id, 128), offset: integer(input.offset, 0), limit: optionalInteger(input.limit, 1, 512 * 1024) })
        } else if (method === 'terminalRecordingDelete') {
          if (args.length !== 1) throw new Error('invalid_workbench_request')
          await manager.deleteRecording(text(args[0], 128)); result = true
        } else if (method === 'terminalAttach') {
          if (args.length !== 1) throw new Error('invalid_workbench_request')
          const id = text(args[0], 128)
          const session = manager.session(id)
          const ownershipEpoch = output.attach(id)
          scope.events.splice(0, scope.events.length, ...scope.events.filter((row) => row.event.kind === 'data' ? !row.event.events.some((event) => event.id === id) : row.event.event.id !== id))
          result = { ...session, ownershipEpoch, catchUp: await manager.recordingCheckpoint(id) }
        } else {
          const id = text(args[0], 128), epoch = integer(args[1], 1)
          const ackKey = `${id}:${epoch}`
          const acknowledged = scope.acknowledged.get(ackKey) ?? 0
          if (method === 'terminalAck' && args.length === 3 && integer(args[2], 0) <= acknowledged) return true
          if (!output.owns(id, epoch)) throw new Error('stale_terminal_owner')
          if (method === 'terminalWrite' && args.length === 3) {
            const data = text(args[2], TERMINAL_MAX_INPUT_BYTES, true)
            if (Buffer.byteLength(data) > TERMINAL_MAX_INPUT_BYTES) throw new Error('terminal_input_too_large')
            manager.write({ id, data }); result = true
          } else if (method === 'terminalResize' && args.length === 4) {
            manager.resize({ id, cols: integer(args[2], 1, TERMINAL_MAX_DIMENSION), rows: integer(args[3], 1, TERMINAL_MAX_DIMENSION) }); result = true
          } else if (method === 'terminalReady' && args.length === 2) result = output.ready(id, epoch)
          else if (method === 'terminalAck' && args.length === 3) {
            const total = integer(args[2], 0)
            result = output.ack(id, epoch, total - acknowledged)
            if (result) scope.acknowledged.set(ackKey, total)
          }
          else if (method === 'terminalDetach' && args.length === 2) { output.detach(id); result = true }
          else if (method === 'terminalClose' && args.length === 2) { output.terminalClosed(id); manager.close({ id }); result = true }
          else throw new Error('invalid_workbench_method')
        }
      }
      authorizeRequest()
      if (Buffer.byteLength(JSON.stringify(result ?? null)) > 4 * 1024 * 1024 - 1024) throw new Error('desktop_workbench_response_too_large')
      return result ?? null
    },
    release,
    async dispose() {
      disposed = true
      await Promise.all([...scopes.keys()].map(release))
    }
  }
}
