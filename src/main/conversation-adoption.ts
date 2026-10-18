import { createHash } from 'node:crypto'
import type { AppSession } from './app-store'
import type { ConversationAdoptionPreview, ConversationLegacySource } from '../shared/conversation-api'
import type { ConversationSeed } from './conversation-store'
import { assertConversationHistoryReadable, conversationItemsFromTrace } from './conversation-history'
import { SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import { readTraceArchiveForMigration } from './transcript-archive'
import { parseConversationTarget } from './conversation-service'

export function parseConversationLegacySource(value: unknown): ConversationLegacySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('迁移源请求无效')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['providerId', 'agentProfileId', 'cwd', 'externalSessionId'].includes(key)) ||
    typeof source.cwd !== 'string' || !source.cwd || typeof source.externalSessionId !== 'string' || !source.externalSessionId) {
    throw new Error('迁移仅支持已登记的本机会话和工作区')
  }
  const target = parseConversationTarget({ providerId: source.providerId, agentProfileId: source.agentProfileId })
  return { providerId: target.providerId as ConversationLegacySource['providerId'],
    ...(target.agentProfileId ? { agentProfileId: target.agentProfileId } : {}),
    cwd: source.cwd, externalSessionId: source.externalSessionId }
}

/** Pure archive read. Caller holds the existing provider/cwd admission and checks live writers. */
export async function prepareConversationAdoption(userData: string, source: ConversationLegacySource, catalog: AppSession, requireHandoff = false): Promise<{
  preview: ConversationAdoptionPreview
  seed: ConversationSeed
}> {
  const archive = await readTraceArchiveForMigration({ userDataDir: userData, cwd: source.cwd,
    providerId: source.providerId, sessionId: source.externalSessionId })
  if (!archive?.turns.length) throw new Error('没有可完整迁入的 App 捕获归档；旧入口保留')
  if (archive.turns.some(turn => !turn.done || turn.items.some(event => event.steer))) {
    throw new Error('迁移仅支持已收敛的捕获；未收敛或 Steer 历史需先核查，旧入口保留')
  }
  const turns: ConversationSeed['turns'] = []
  for (const turn of archive.turns) {
    turns.push({ runId: turn.runId,
      items: await conversationItemsFromTrace({ userData, conversation: { cwd: source.cwd }, runId: turn.runId,
        userText: turn.userText, items: turn.items }),
      nativeItems: [],
      archive: { sessionId: source.externalSessionId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}) } })
  }
  if (requireHandoff) {
    // Preserve complete captured text, including partial work from terminal failures.
    // Historical attachments stay in the archive/UI, never in the handoff payload.
    // The current target, input budget and retrieval tool are checked on Send.
    await assertConversationHistoryReadable(userData, {
      cwd: source.cwd,
      bindings: [{ id: source.externalSessionId, providerId: source.providerId, agentProfileId: source.agentProfileId,
        continuationKey: 'unverified-legacy', nativeSessionId: source.externalSessionId }],
      turns: turns.map((turn, index) => ({ ...turn, ordinal: index + 1, bindingId: source.externalSessionId, origin: 'imported' as const }))
    }, turns.flatMap(turn => turn.items))
  }
  const title = catalog.title ?? (catalog.preview.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX_LENGTH) || '对话')
  const fingerprint = createHash('sha256').update(JSON.stringify({ source, archive, turns, title,
    pinnedAt: catalog.pinnedAt, archivedAt: catalog.archivedAt })).digest('hex')
  return {
    preview: { source, fingerprint, title, turnCount: turns.length },
    seed: { target: { providerId: source.providerId, ...(source.agentProfileId ? { agentProfileId: source.agentProfileId } : {}), continuationKey: `unverified-legacy:${fingerprint}` },
      nativeSessionId: source.externalSessionId, retiredReason: '旧捕获未记录可证明的接续身份；后续需明确新建原生上下文',
      adoptionFingerprint: fingerprint, title, pinnedAt: catalog.pinnedAt, archivedAt: catalog.archivedAt, turns }
  }
}
