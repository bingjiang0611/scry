import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { unavailable, type Evidence } from '../shared/turn-record'
import { discoverTraceArchiveSessionsAsync, resolveTranscriptPath, transcriptDir, transcriptPath } from '../main/transcript-archive'
import { trustedOwnedFile } from '../main/transcript-archive-paths'
import { isSessionProviderId, type createAppSessionStore } from '../main/app-store'
import type { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'
import { locatePiNativeSession, piNativeSessionDirectory } from '../main/pi-native-history'
import { matchesPiIdentity } from './orchestration-native-source'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { CatalogSubscriptionScans } from '../host-runtime/orchestration/catalog-subscription-scans'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { SessionDiscoverPayload } from '../host-runtime/orchestration/orchestrator-commands'
import {
  captureTranscriptInterval, catalogFrontierKey, readTranscriptExtent, resolveTranscriptInterval,
  type TranscriptExtent, type TranscriptSource
} from '../host-runtime/orchestration/transcript-interval'
import type { SessionProjectionRow } from '../host-runtime/orchestration/types'
import { wasNativeSourceDeleted } from '../host-runtime/orchestration/native-session-lookup'
import { isWithdrawableSession } from '../host-runtime/orchestration/orchestrator-handlers'

interface CatalogScanOptions {
  sink: EventSink
  homeDir: string
  userDataDir: string
  workspaces(): Iterable<string>
  isActive(session: SessionProjectionRow): boolean
  onDiscovered?(session: SessionDiscoverPayload): void
  log(message: string): void
}

interface ObservedTranscript {
  source: TranscriptSource
  extent: TranscriptExtent
  reference?: string
}

interface StoredTranscript {
  source: TranscriptSource
  extent: { device: string; inode: string; mtimeNs: string; birthtimeNs: string; size: number }
  reference?: string
}

function encodeFrontier(observed: ObservedTranscript | null): string {
  if (!observed) return 'null'
  const { device, inode, mtimeNs, birthtimeNs, size } = observed.extent
  return JSON.stringify({
    ...observed, extent: {
      device: String(device), inode: String(inode), mtimeNs: String(mtimeNs), birthtimeNs: String(birthtimeNs), size
    }
  } satisfies StoredTranscript)
}

function decodeFrontier(value: string | undefined): ObservedTranscript | undefined {
  if (!value) return undefined
  const row = JSON.parse(value) as StoredTranscript | null
  if (!row) return undefined
  const { device, inode, mtimeNs, birthtimeNs, size } = row.extent
  return { ...row, extent: { device: BigInt(device), inode: BigInt(inode), mtimeNs: BigInt(mtimeNs), birthtimeNs: BigInt(birthtimeNs), size } }
}

function sameExtent(previous: TranscriptExtent, current: TranscriptExtent): boolean {
  return previous.device === current.device && previous.inode === current.inode &&
    previous.size === current.size && previous.mtimeNs === current.mtimeNs
}

async function listNativeEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Watches Provider files already under authorized roots. Only metadata and evidence
 * references go to the command log. The content channel owns history pages. */
export function createCatalogScanWork(options: CatalogScanOptions) {
  const { sink, homeDir, userDataDir } = options
  const seen = new Map<string, ObservedTranscript>()
  const lastObservation = (sessionKey: string): ObservedTranscript | undefined =>
    seen.get(sessionKey) ?? decodeFrontier(sink.getMeta(catalogFrontierKey(sessionKey)))
  const piRoot = join(homeDir, '.pi', 'agent', 'sessions')
  const onError = (error: unknown): void => {
    options.log(`daemon.catalog-scan ${error instanceof Error ? error.message : String(error)}`)
  }
  const getKey = (provider: string, cwd: string, nativeSessionId: string): string => {
    const selected = sink.handle.db.prepare(
      `SELECT session_key AS key FROM orch_p_session
       WHERE provider = ? AND cwd = ? AND profile IS NULL AND conversation_id IS NULL
         AND (json_extract(catalog, '$.nativeSessionId') = ? OR (catalog IS NULL AND session_key = ?))
       LIMIT 1`
    ).get(provider, cwd, nativeSessionId, nativeSessionId) as { key: string } | undefined
    return selected?.key ?? `native:${sha256Hex(canonicalJson([provider, cwd, nativeSessionId]))}`
  }
  const publish = (payload: SessionDiscoverPayload, at: number, observation?: ObservedTranscript | null): void => {
    if (!sink.handle.db.open || sink.isWriteIndeterminate()) return
    const existing = sink.getSession(payload.sessionKey)
    if (!existing && payload.provider && payload.catalog?.nativeSessionId && wasNativeSourceDeleted(sink, {
      sessionId: payload.catalog.nativeSessionId, provider: payload.provider, profile: null, cwd: payload.cwd
    })) return
    if (!existing && sink.handle.db.prepare(
      "SELECT 1 FROM orch_event WHERE session_key IN (?, ?) AND cwd = ? AND type = 'session.deleted' LIMIT 1"
    ).get(payload.sessionKey, payload.catalog?.nativeSessionId ?? '', payload.cwd)) return
    const payloadSha256 = sha256Hex(canonicalJson(payload))
    const result = sink.runInBatchTransaction(() => {
      const update = sink.execute({
        type: 'session.discover',
        commandId: `catalog-scan:${payload.sessionKey}:${existing?.revSeq ?? 0}:${payloadSha256.slice(0, 16)}`,
        actor: 'system',
        scope: 'system',
        at,
        payload,
        payloadSha256
      })
      if (update.kind === 'accepted' && observation !== undefined) {
        sink.setMeta(catalogFrontierKey(payload.sessionKey), encodeFrontier(observation))
      }
      return update
    })
    if (result.kind === 'accepted' && !existing) options.onDiscovered?.(payload)
  }

  const readSource = async (source: TranscriptSource, session: SessionDiscoverPayload): Promise<void> => {
    const observed = lastObservation(session.sessionKey)
    const previous = observed?.source.path === source.path ? observed : undefined
    const current = await readTranscriptExtent(source)
    if (!current) {
      if (previous) {
        seen.delete(session.sessionKey)
        publish({ ...session, transcript: unavailable('source_removed', previous.reference ? [previous.reference] : []) }, Date.now(), null)
      }
      return
    }
    if (previous && previous.source.path === source.path && sameExtent(previous.extent, current)) return
    if (!trustedOwnedFile(homeDir, source.path)) return
    const matches = source.provider === 'claude'
      ? resolveTranscriptPath({ cwd: session.cwd, sessionId: source.nativeSessionId, userDataDir, home: homeDir }) === source.path
      : await matchesPiIdentity(source.path, session.cwd, source.nativeSessionId)
    if (!matches) return

    let transcript: Evidence<string>
    if (previous?.reference && previous.extent.size === current.size) {
      const verified = await resolveTranscriptInterval(source, previous.reference)
      if (verified.status === 'available') {
        seen.set(session.sessionKey, { ...previous, extent: current })
        return
      }
      transcript = unavailable(verified.omissionReason ?? 'source_changed', verified.source)
    } else {
      transcript = await captureTranscriptInterval(source, previous?.extent, current)
    }
    seen.delete(session.sessionKey)
    const observation = { source, extent: current, reference: transcript.value ?? previous?.reference }
    seen.set(session.sessionKey, observation)
    if (seen.size > 128) seen.delete(seen.keys().next().value!)
    publish({
      ...session,
      transcript,
      ...(transcript.status === 'available' ? { evidence: transcript.source } : {})
    }, Number(current.mtimeNs / 1_000_000n), observation)
  }

  async function scanDetail(sessionKey: string, opening: boolean): Promise<void> {
    if (!sink.handle.db.open || sink.isWriteIndeterminate()) return
    const session = sink.getSession(sessionKey)
    if (!session || !session.cwd || session.conversationId || (!opening && options.isActive(session))) return
    const { cwd, provider, profile } = session
    if (provider !== 'claude' && provider !== 'pi') return
    const nativeSessionId = session.catalog ? session.catalog.nativeSessionId : session.sessionKey
    if (!nativeSessionId) return
    // An imported row may name a directory that has since been removed.
    if (![...options.workspaces()].includes(cwd)) return
    const observed = lastObservation(sessionKey)
    const known = observed?.source.provider === provider && observed.source.nativeSessionId === nativeSessionId ? observed : undefined
    const path = known?.source.path ?? (provider === 'claude'
      ? transcriptPath(cwd, nativeSessionId, homeDir)
      : (await locatePiNativeSession({ sessionRoot: piRoot, cwd, sessionId: nativeSessionId }))?.canonical)
    if (!path) return
    await readSource({ provider, nativeSessionId, path }, { sessionKey, provider, profile, cwd })
  }

  // Earlier builds listed every terminal transcript under a known workspace. Withdraw
  // the rows that scan created and Scry never ran, named, pinned or archived.
  function withdrawExternalOnly(): void {
    if (!sink.handle.db.open || sink.isWriteIndeterminate()) return
    const rows = sink.handle.db.prepare(
      `SELECT session.session_key AS sessionKey FROM orch_p_session AS session
       WHERE session.conversation_id IS NULL AND session.catalog IS NOT NULL
         AND json_extract(session.catalog, '$.nativeSessionId') IS NOT NULL
         AND json_extract(session.catalog, '$.preview') IS NULL
         AND session.last_run_id IS NULL AND session.active_run_id IS NULL AND session.title IS NULL
         AND session.pinned_at IS NULL AND session.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM orch_p_run AS run WHERE run.session_key = session.session_key)
         AND NOT EXISTS (SELECT 1 FROM orch_event AS event
           WHERE event.session_key = session.session_key AND event.type = 'session.imported')`
    ).all() as { sessionKey: string }[]
    if (rows.length === 0) return
    sink.runInBatchTransaction(() => {
      for (const { sessionKey } of rows) {
        const session = sink.getSession(sessionKey)
        if (!session || !isWithdrawableSession(session)) continue
        const payload = { sessionKey }
        sink.execute({
          type: 'session.withdraw',
          commandId: `catalog-withdraw-external:${sessionKey}:${session.revSeq}`,
          actor: 'system',
          scope: 'system',
          at: Date.now(),
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        })
      }
    })
  }

  async function scanCatalog(): Promise<void> {
    withdrawExternalOnly()
    const workspaces = new Set(options.workspaces())
    if (workspaces.size === 0) return
    for (const cwd of workspaces) {
      for (const provider of ['claude', 'pi'] as const) {
        const dir = provider === 'claude' ? transcriptDir(cwd, homeDir) : piNativeSessionDirectory(piRoot, cwd)
        const paths = new Map<string, string | null>()
        for (const entry of await listNativeEntries(dir)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !sink.handle.db.open) continue
          const stem = basename(entry.name, '.jsonl')
          const nativeSessionId = provider === 'claude' ? stem : stem.split('_').at(-1)!
          if (!/^[a-f0-9-]{36}$/i.test(nativeSessionId)) continue
          paths.set(nativeSessionId, paths.has(nativeSessionId) ? null : join(dir, entry.name))
        }
        for (const [nativeSessionId, path] of paths) {
          if (!path) continue
          if (!sink.handle.db.open) return
          const sessionKey = getKey(provider, cwd, nativeSessionId)
          const existing = sink.getSession(sessionKey)
          // Only sessions Scry already knows are followed. A transcript started in a
          // terminal is not listed in the catalog (the behaviour before P4-4).
          if (!existing || options.isActive(existing)) continue
          await readSource({ provider, nativeSessionId, path }, { sessionKey, provider, cwd })
        }
      }
    }

    for (const summary of await discoverTraceArchiveSessionsAsync(userDataDir)) {
      if (!workspaces.has(summary.cwd) || !sink.handle.db.open) continue
      const { providerId: provider, sessionId: nativeSessionId, cwd, runtimeProvider } = summary
      const sessionKey = getKey(provider, cwd, nativeSessionId)
      if (sink.getSession(sessionKey)) continue
      publish({
        sessionKey, provider, cwd,
        catalog: { nativeSessionId, projectCwd: null, preview: summary.prompt.slice(0, 200), runtimeProvider }
      }, summary.ts)
    }
  }

  return { scanCatalog, scanDetail, onError }
}

export function createDaemonCatalogScans(
  sink: EventSink,
  userDataDir: string,
  workspace: Pick<ReturnType<typeof createWorkspaceRuntime>, 'homeDir' | 'remoteProjectRoots'>,
  store: () => ReturnType<typeof createAppSessionStore>,
  onChanged: () => void,
  log: (line: string) => void
): CatalogSubscriptionScans {
  return new CatalogSubscriptionScans(createCatalogScanWork({
    sink,
    userDataDir,
    homeDir: workspace.homeDir,
    workspaces: workspace.remoteProjectRoots,
    isActive: (session) => session.activeRunId !== null,
    onDiscovered: ({ provider, cwd, catalog }) => {
      if (!catalog?.nativeSessionId || !catalog.runtimeProvider ||
          !isSessionProviderId(provider) || provider === 'legacy_unknown') return
      const externalSessionId = catalog.nativeSessionId
      if (!store().load().some((row) => row.providerId === provider && row.cwd === cwd &&
          row.agentProfileId === undefined && row.externalSessionId === externalSessionId)) {
        // This catalog is still the source served by the existing history readers.
        store().record({
          providerId: provider,
          runtimeProvider: catalog.runtimeProvider,
          cwd,
          externalSessionId,
          prompt: catalog.preview ?? ''
        })
      }
      onChanged()
    },
    log
  }))
}
