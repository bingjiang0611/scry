import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { SideChatNativeSource, SideChatNativeTurn, SideChatSourceDeps } from '../conversation-service-deps'
import { MAX_CONVERSATION_HISTORY_SOURCE_BYTES } from '../conversation-history-limits'
import type { NormalizeCtx } from '../normalize'
import { parseTranscriptToTurns, type ParsedTurn } from '../normalize'
import { readPiNativeHistory } from '../pi-native-history'
import { archivedTranscriptPath, resolveTranscriptPath, transcriptPath } from '../transcript-archive'

export interface SideChatSourceRuntime {
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  resolveKnownProjectDirectory: (cwd: string) => string
  homeDir: string
  userDataDir: string
}

/** Claude and Pi ship bounded native readers; the other Providers stay archive-only. */
const nativeReaders = new Set<ProviderId>(['claude', 'pi'])

/**
 * Bounded, append-tolerant read of a live JSONL transcript.
 *
 * A session that is still running keeps appending records, so requiring the whole
 * file to stay byte-identical would refuse every live source. Only the captured
 * prefix is used: the frozen content ends at the last newline that was complete
 * when the bytes were read, and a later appended turn can never change it. A
 * shrunk or replaced file proves nothing about that prefix and is refused.
 */
async function readBoundedTranscript(path: string, runId: string): Promise<ParsedTurn[]> {
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return []
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('原生会话 transcript 不是普通文件')
    if (before.size > MAX_CONVERSATION_HISTORY_SOURCE_BYTES) {
      throw new Error('原生会话超过 16 MiB 侧聊来源读取预算')
    }
    const buffer = Buffer.allocUnsafe(before.size)
    let read = 0
    while (read < buffer.length) {
      const chunk = await handle.read(buffer, read, buffer.length - read, read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    if (read !== before.size) throw new Error('原生会话 transcript 读取不完整')
    const after = await handle.stat()
    if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size) {
      throw new Error('原生会话 transcript 在读取期间被替换或截断，不能确认快照来源')
    }
    return parseTranscriptToTurns(completeRecords(buffer), parseContext(runId))
  } finally {
    await handle.close()
  }
}

/** Refuse an oversized candidate before its identity or content is read. */
async function assertTranscriptBudget(candidates: readonly string[]): Promise<void> {
  for (const candidate of candidates) {
    const size = await stat(candidate).then(info => info.size, () => undefined)
    if (size !== undefined && size > MAX_CONVERSATION_HISTORY_SOURCE_BYTES) {
      throw new Error('原生会话超过 16 MiB 侧聊来源读取预算')
    }
  }
}

/** Complete newline-terminated records only; a half-written tail is not evidence. */
function completeRecords(buffer: Buffer): string {
  const complete = buffer.lastIndexOf(10) + 1
  return buffer.subarray(0, complete).toString('utf8')
}

function parseContext(runId: string): NormalizeCtx {
  let next = 0
  const now = new Date().toISOString()
  return { runId, newId: () => `side-chat-source-${next++}`, now: () => now }
}

/**
 * Read-only native source seam for side chats.
 *
 * Identity comes from the App catalog, not from the request: the Provider/profile/
 * cwd/session tuple must match exactly one catalog session, and the project must
 * already be an authorized known project. No adapter starts, no auth is probed and
 * no ownership is written here.
 */
export function createSideChatSourceDeps(runtime: SideChatSourceRuntime): SideChatSourceDeps {
  const assertNativeSource = async (source: SideChatNativeSource): Promise<void> => {
    const cwd = runtime.resolveKnownProjectDirectory(source.cwd)
    if (cwd !== source.cwd) throw new Error('侧聊原生来源工作区不是已授权的规范目录')
    // Match the Provider session id first, then require one Profile: the same id
    // under two profiles would make shared archive evidence unattributable.
    const identityMatches = runtime.appSessionStore().load().filter(session =>
      session.providerId === source.providerId &&
      (session.sessionId === source.nativeSessionId || session.externalSessionId === source.nativeSessionId))
    if (identityMatches.length === 0) throw new Error('侧聊原生来源不属于已登记的 App 会话')
    if (new Set(identityMatches.map(session => session.agentProfileId ?? '')).size > 1) {
      throw new Error('侧聊原生来源存在跨 Profile 的身份，不能确认归档归属')
    }
    const matches = identityMatches.filter(session => (session.agentProfileId ?? undefined) === source.agentProfileId)
    if (matches.length === 0) throw new Error('侧聊原生来源的 Profile 与已登记会话不一致')
    // A catalog row without a workspace cannot prove which files it owns, and a
    // row from another workspace may reach a same-named session id.
    for (const match of matches) {
      if (runtime.resolveKnownProjectDirectory(match.cwd) !== cwd) {
        throw new Error('侧聊原生来源工作区与已登记会话不一致')
      }
    }
  }
  const readNativeTurns = async (source: SideChatNativeSource): Promise<SideChatNativeTurn[] | null> => {
    if (!nativeReaders.has(source.providerId)) return null
    if (source.providerId === 'pi') {
      const turns = await readPiNativeHistory({
        sessionRoot: join(runtime.homeDir, '.pi', 'agent', 'sessions'),
        cwd: source.cwd, sessionId: source.nativeSessionId,
        maxBytes: MAX_CONVERSATION_HISTORY_SOURCE_BYTES
      })
      return turns?.map(turn => ({
        runId: turn.runId!, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
        ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
        userText: turn.userText, items: turn.items
      })) ?? null
    }
    // Enforce the source budget before any transcript read: identity inspection
    // reads the whole file and hydration parses it.
    await assertTranscriptBudget([
      transcriptPath(source.cwd, source.nativeSessionId, runtime.homeDir),
      archivedTranscriptPath(runtime.userDataDir, source.cwd, source.nativeSessionId)
    ])
    const path = resolveTranscriptPath({
      cwd: source.cwd, sessionId: source.nativeSessionId, userDataDir: runtime.userDataDir, home: runtime.homeDir
    })
    if (!path) return null
    // A transcript carries no Scry run identity: its turns share the session-scoped
    // id and are told apart by position in the frozen prefix, not by an invented run.
    const parsed = await readBoundedTranscript(path, source.nativeSessionId)
    return parsed.map(turn => ({
      runId: source.nativeSessionId,
      ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
      userText: turn.userText, items: turn.items
    }))
  }
  return { assertNativeSource, readNativeTurns }
}
