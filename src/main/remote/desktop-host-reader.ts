import type { DesktopHostRead, DesktopHostReadResult, DesktopRemoteContext } from '../../shared/desktop-remote'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { mergeSessionTurns } from '../session-history'
import { readTraceArchivePageAsync, readTraceArchiveVersionAsync } from '../transcript-archive'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const PROVIDERS: readonly string[] = ['claude', 'codex', 'qoder', 'opencode', 'pi']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('invalid_request')
  return value
}

export function parseDesktopHostRead(value: unknown): DesktopHostRead {
  const query = object(value)
  if (query.kind === 'info') return { kind: 'info' }
  if (query.kind !== 'history' && query.kind !== 'trace') throw new Error('invalid_request')
  const input = object(query.context)
  const providerId = text(input.providerId, 64)
  if (!PROVIDERS.includes(providerId)) throw new Error('provider_unsupported')
  const context: DesktopRemoteContext = {
    providerId,
    cwd: text(input.cwd, 4096),
    ...(input.agentProfileId === undefined ? {} : { agentProfileId: text(input.agentProfileId, 128) }),
    ...(input.externalSessionId === undefined ? {} : { externalSessionId: text(input.externalSessionId, 256) })
  }
  if (query.kind === 'trace') return { kind: 'trace', context, runId: text(query.runId, 128) }
  if (!context.externalSessionId) throw new Error('session_required')
  if (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 0)) throw new Error('invalid_request')
  return {
    kind: 'history', context,
    ...(query.before === undefined ? {} : { before: query.before as number }),
    ...(query.snapshot === undefined ? {} : { snapshot: text(query.snapshot, 128) })
  }
}

// This reader is injected only by the App composition using canonical run
// orchestration. It is not an alternate execution surface or a filesystem proxy.
export function createDesktopHostReader(deps: {
  userDataDir: string
  hostId(): string
  authorizeWorkspace(cwd: string): string
  getRun(runId: string): ActiveRun | null
}): (query: DesktopHostRead) => Promise<DesktopHostReadResult> {
  return async (query) => {
    if (query.kind === 'info') return { kind: 'info', protocol: 1, hostId: deps.hostId(), execution: 'canonical' }
    const cwd = deps.authorizeWorkspace(query.context.cwd)
    const context = { ...query.context, cwd }
    let result: DesktopHostReadResult
    if (query.kind === 'trace') {
      const run = deps.getRun(query.runId)
      if (run && (run.cwd !== cwd || run.providerId !== context.providerId ||
          (run.agentProfileId ?? '') !== (context.agentProfileId ?? '') ||
          (context.externalSessionId !== undefined && run.externalSessionId !== context.externalSessionId))) {
        throw new Error('run_context_mismatch')
      }
      result = { kind: 'trace', run }
    } else {
      const args = {
        cwd, providerId: context.providerId as ProviderId,
        sessionId: context.externalSessionId!, userDataDir: deps.userDataDir
      }
      const version = await readTraceArchiveVersionAsync(args)
      if (query.snapshot !== undefined && query.snapshot !== version.version) throw new Error('history_snapshot_changed')
      const page = await readTraceArchivePageAsync(args, { limit: 2, ...(query.before === undefined ? {} : { before: query.before }) })
      const after = await readTraceArchiveVersionAsync(args)
      if (version.version !== after.version) throw new Error('history_snapshot_changed')
      // Do not hydrate host filesystem attachment paths into client-local URLs.
      // Tool bodies remain honestly bounded by the existing history projection.
      const turns = mergeSessionTurns([], page.archive, undefined, { hydrateAttachments: false })
      result = {
        kind: 'history', history: {
          turns, hasOlder: page.hasOlder, before: page.offset, snapshot: after.version,
          source: 'trace_archive', status: page.archive ? 'available' : 'unavailable',
          ...(page.archive ? {} : { reason: 'trace_archive_unavailable' })
        }
      }
    }
    // A read may await archive IO while the host removes a workspace grant.
    deps.authorizeWorkspace(cwd)
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) throw new Error('desktop_evidence_response_too_large')
    return result
  }
}
