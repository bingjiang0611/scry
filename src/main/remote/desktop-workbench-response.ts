import type { DesktopWorkbenchRequest } from '../../shared/desktop-workbench'

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function string(value: unknown): value is string { return typeof value === 'string' }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function entry(value: unknown): boolean {
  return object(value) && string(value.path) && string(value.name) && (value.kind === 'file' || value.kind === 'directory') && number(value.mtimeMs)
}
function terminal(value: unknown): boolean {
  return object(value) && string(value.id) && string(value.cwd) && number(value.pid) && number(value.cols) && number(value.rows)
}
function operation(value: unknown): boolean {
  return object(value) && string(value.id) && string(value.repositoryId) && number(value.startedAt) && string(value.message) && ['stage', 'unstage', 'commit', 'fetch', 'push', 'createPr', 'review', 'merge'].includes(String(value.action)) && ['running', 'succeeded', 'failed', 'unknown'].includes(String(value.status))
}
export function validateDesktopWorkbenchResponse(query: DesktopWorkbenchRequest, value: unknown): void {
  let valid = false
  if (query.surface === 'workspace') {
    switch (query.method) {
      case 'workspaceList': valid = object(value) && Array.isArray(value.entries) && value.entries.every(entry) && typeof value.truncated === 'boolean'; break
      case 'workspaceRead': case 'workspaceReadKnown': case 'workspaceWrite':
        valid = object(value) && string(value.path) && string(value.name) && string(value.content) && string(value.revision) && string(value.language) && number(value.size) && number(value.mtimeMs); break
      case 'workspaceReadPage': case 'workspaceReadPageKnown':
        valid = object(value) && string(value.path) && string(value.name) && string(value.content) && string(value.snapshot) && number(value.offset) && number(value.nextOffset) && number(value.totalBytes) && typeof value.hasMore === 'boolean'; break
      case 'workspaceCreate': case 'workspaceRename': case 'workspaceMove': valid = entry(value); break
      default: valid = typeof value === 'boolean'
    }
  } else if (query.surface === 'terminal') {
    switch (query.method) {
      case 'terminalStart': valid = terminal(value) && object(value) && Number.isSafeInteger(value.ownershipEpoch); break
      case 'terminalAttach': valid = terminal(value) && object(value) && Number.isSafeInteger(value.ownershipEpoch) && object(value.catchUp) && number(value.catchUp.endOffset) && ['available', 'partial', 'unavailable'].includes(String(value.catchUp.state)); break
      case 'terminalActive': valid = Array.isArray(value) && value.every(terminal); break
      case 'terminalRecordingList': valid = object(value) && Array.isArray(value.items) && value.items.every(item => object(item) && string(item.id) && number(item.bytes) && string(item.state) && typeof item.active === 'boolean') && (value.nextCursor === null || string(value.nextCursor)) && typeof value.partial === 'boolean'; break
      case 'terminalRecordingRead': valid = object(value) && string(value.id) && string(value.data) && value.encoding === 'utf16le' && number(value.offset) && number(value.nextOffset) && number(value.totalBytes) && typeof value.hasMore === 'boolean' && string(value.state); break
      case 'terminalEvents':
        valid = object(value) && string(value.cursor) && /^[0-9a-f-]{36}:\d+$/.test(value.cursor) && Array.isArray(value.events) && value.events.every(row => {
          if (!object(row)) return false
          if (row.kind === 'data') return Array.isArray(row.events) && row.events.every(event => object(event) && string(event.id) && string(event.data) && Number.isSafeInteger(event.ownershipEpoch))
          if (!object(row.event) || !string(row.event.id)) return false
          return row.kind === 'recordingError' ? string(row.event.message) : row.kind === 'exit' && (row.event.code === null || number(row.event.code)) && (row.event.signal === null || number(row.event.signal))
        }); break
      default: valid = typeof value === 'boolean'
    }
  } else {
    switch (query.method) {
      case 'read': case 'diff': case 'pullRequests': case 'pullRequest': {
        valid = object(value) && (value.status === 'available' ? object(value.data) : ['unavailable', 'failed'].includes(String(value.status)) && string(value.reason))
        if (valid && object(value) && value.status === 'available' && object(value.data)) {
          const data = value.data
          if (query.method === 'read') valid = string(data.id) && string(data.root) && string(data.revision) && Array.isArray(data.files) && data.files.every(file => object(file) && string(file.path) && string(file.index) && string(file.worktree) && typeof file.untracked === 'boolean' && typeof file.conflict === 'boolean') && Array.isArray(data.remotes) && object(data.actionBlockers) && (data.writeBlocker === null || string(data.writeBlocker))
          else if (query.method === 'diff') valid = string(data.patch) && typeof data.truncated === 'boolean' && typeof data.binary === 'boolean'
          else if (query.method === 'pullRequests') valid = Array.isArray(data.items) && string(data.repository)
          else valid = number(data.number) && string(data.head) && string(data.base) && Array.isArray(data.files)
        }
        break
      }
      case 'operations': valid = Array.isArray(value) && value.every(operation); break
      case 'mutate': case 'reconcile': case 'acknowledge': valid = operation(value); break
      case 'loadCommitDraft': case 'loadDraft': valid = value === null || object(value) && string(value.repositoryId); break
      case 'saveCommitDraft': case 'saveDraft': valid = value === null; break
    }
  }
  if (!valid) throw new Error('invalid_desktop_workbench_response')
}
