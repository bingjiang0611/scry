import type { DesktopWorkbenchRequest, DesktopWorkbenchResult } from '../../shared/desktop-workbench'
import { parseDesktopWorkbenchQuery } from './desktop-workbench'
import { validateDesktopWorkbenchResponse } from './desktop-workbench-response'
import type { DesktopRemoteContext } from '../../shared/desktop-remote'
import type { WorkspaceFilePage, WorkspaceListResult } from '../../shared/workspace'
import { DesktopRemoteClientRun } from './desktop-client-run'
import { context, fail, record, pathText, text, MAX_ITEMS } from './desktop-client-validation'

export class DesktopRemoteClientWorkbench extends DesktopRemoteClientRun {
  async workbench<Request extends DesktopWorkbenchRequest>(connectionIdValue: string, request: Request): Promise<DesktopWorkbenchResult<Request>> {
    const query = parseDesktopWorkbenchQuery(request)
    const wire = { op: 'desktopWorkbench', query }
    const read = ['workspaceList', 'workspaceRead', 'workspaceReadKnown', 'workspaceReadPage', 'workspaceReadPageKnown', 'terminalActive', 'terminalEvents', 'terminalRecordingList', 'terminalRecordingRead', 'read', 'diff', 'operations', 'pullRequests', 'pullRequest', 'loadCommitDraft', 'loadDraft'].includes(query.method)
    // Writes are serialized and never automatically retried, including PTY input.
    const response = read ? await this.requestForConnection(connectionIdValue, wire) : await this.write(connectionIdValue, wire)
    if (!record(response) || !Object.hasOwn(response, 'workbench')) fail('invalid_desktop_workbench_response')
    validateDesktopWorkbenchResponse(request, response.workbench)
    return response.workbench as DesktopWorkbenchResult<Request>
  }

  async files(connectionIdValue: string, value: DesktopRemoteContext, path: string, cursor?: string): Promise<WorkspaceListResult> {
    if (!pathText(path, 16_384) || (cursor !== undefined && !pathText(cursor, 4096))) fail('invalid_path')
    const response = await this.requestForConnection(connectionIdValue, { op: 'workspace', query: { action: 'list', cwd: context(value).cwd, path, ...(cursor === undefined ? {} : { cursor }) } })
    if (!record(response) || !record(response.workspace) || response.workspace.action !== 'list' || !record(response.workspace.listing)) fail('invalid_workspace_response')
    const listing = response.workspace.listing
    if (!Array.isArray(listing.entries) || listing.entries.length > MAX_ITEMS || typeof listing.truncated !== 'boolean' || (listing.nextCursor !== undefined && !text(listing.nextCursor, 4096))) fail('invalid_workspace_response')
    for (const entry of listing.entries) if (!record(entry) || !text(entry.name, 512) || !text(entry.path, 16_384) || (entry.kind !== 'file' && entry.kind !== 'directory') || !Number.isFinite(entry.mtimeMs) || (entry.size !== undefined && !Number.isSafeInteger(entry.size))) fail('invalid_workspace_response')
    return { entries: listing.entries as unknown as WorkspaceListResult['entries'], truncated: listing.truncated, ...(listing.nextCursor ? { nextCursor: listing.nextCursor } : {}) }
  }

  async file(connectionIdValue: string, value: DesktopRemoteContext, path: string, offset?: number, snapshot?: string): Promise<WorkspaceFilePage> {
    if (!pathText(path, 16_384) || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) || (snapshot !== undefined && !text(snapshot, 4096))) fail('invalid_path')
    const response = await this.requestForConnection(connectionIdValue, { op: 'workspace', query: { action: 'file', cwd: context(value).cwd, path, ...(offset === undefined ? {} : { offset }), ...(snapshot ? { snapshot } : {}) } })
    if (!record(response) || !record(response.workspace) || response.workspace.action !== 'file' || !record(response.workspace.file)) fail('invalid_workspace_response')
    const file = response.workspace.file
    if (!text(file.name, 512) || !text(file.path, 16_384) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 512 * 1024 || !Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.nextOffset) || !Number.isSafeInteger(file.totalBytes) || typeof file.hasMore !== 'boolean' || !text(file.snapshot, 256) || !text(file.language, 128)) fail('invalid_workspace_response')
    return { name: file.name as string, path: file.path as string, content: file.content as string, offset: file.offset as number, nextOffset: file.nextOffset as number, totalBytes: file.totalBytes as number, hasMore: file.hasMore as boolean, snapshot: file.snapshot as string, language: file.language as string }
  }

}
