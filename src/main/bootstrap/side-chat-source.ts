import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { SideChatNativeSource, SideChatNativeTurn, SideChatSourceDeps } from '../conversation-service-deps'
import type { StreamedTurn } from '../conversation-side-chat-stream'
import { streamNativeTranscriptTurns } from '../conversation-side-chat-native-stream'
import { stopReasonProvesCompletion } from '../conversation-side-chat-raw'
import { readPiNativeHistory } from '../pi-native-history'
import { archivedTranscriptPath, transcriptPath } from '../transcript-archive'

export interface SideChatSourceRuntime {
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  resolveKnownProjectDirectory: (cwd: string) => string
  homeDir: string
  userDataDir: string
}

/** Pi ships its own whole-turn reader; every other Provider reads its transcript here. */
const nativeReaders = new Set<ProviderId>(['pi'])

/** First existing regular, non-link file; a symlink is never a trusted transcript. */
async function firstTrustedFile(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const stat = await lstat(path)
      if (stat.isFile()) return path
    } catch {
      // A missing candidate is simply not this source's transcript.
    }
  }
  return undefined
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
    // Pi streams its own JSONL lines; a byte ceiling here would refuse a long
    // session instead of letting the frozen prefix decide what is captured.
    const turns = await readPiNativeHistory({
      sessionRoot: join(runtime.homeDir, '.pi', 'agent', 'sessions'),
      cwd: source.cwd, sessionId: source.nativeSessionId
    })
    return turns?.map(turn => ({
      runId: turn.runId!, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
      userText: turn.userText, items: turn.items
    })) ?? null
  }
  /**
   * Claude's transcript is projected record by record: a whole tool result is never parsed
   * into a value, and a visible body is spooled instead of accumulated. A transcript carries
   * no Scry run identity, so its turns share the session-scoped id and are told apart by
   * position in the frozen prefix, not by an invented run.
   */
  const streamNativeTurns = async (source: SideChatNativeSource): Promise<AsyncGenerator<StreamedTurn> | null> => {
    if (source.providerId !== 'claude') return null
    // The catalog already proved provider/profile/cwd/session; what remains is locating
    // the file. `resolveTranscriptPath` would re-parse every record through the shared
    // whole-file identity check, which both refuses a live tail and loads a huge tool
    // result, so the side-chat path trusts the catalog and lets the transcript's own head
    // prove its session and cwd while it is streamed.
    const path = transcriptPath(source.cwd, source.nativeSessionId, runtime.homeDir)
    const mirror = archivedTranscriptPath(runtime.userDataDir, source.cwd, source.nativeSessionId)
    const chosen = await firstTrustedFile([path, mirror])
    if (!chosen) return null
    return streamNativeTranscriptTurns({
      path: chosen, runId: source.nativeSessionId, sessionId: source.nativeSessionId, cwd: source.cwd,
      settles: stopReason => stopReasonProvesCompletion('claude', { stopReason })
    })
  }
  return { assertNativeSource, streamNativeTurns, readNativeTurns }
}
