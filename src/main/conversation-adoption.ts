import { createHash } from 'node:crypto'
import type { AppSession } from './app-store'
import type { ConversationAdoptionPreview, ConversationLegacySource } from '../shared/conversation-api'
import type { ConversationSeed } from './conversation-store'
import { conversationItemsFromTrace } from './conversation-history'
import { readTraceArchiveForMigration } from './transcript-archive'

export function parseConversationLegacySource(value: unknown): ConversationLegacySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('迁移源请求无效')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['providerId', 'cwd', 'externalSessionId'].includes(key)) ||
    (source.providerId !== 'claude' && source.providerId !== 'codex') ||
    typeof source.cwd !== 'string' || !source.cwd || typeof source.externalSessionId !== 'string' || !source.externalSessionId) {
    throw new Error('迁移仅支持 Claude/Codex 默认配置及已登记的源会话')
  }
  return { providerId: source.providerId, cwd: source.cwd, externalSessionId: source.externalSessionId }
}

/** Pure archive read. Caller holds the existing provider/cwd admission and checks live writers. */
export async function prepareConversationAdoption(userData: string, source: ConversationLegacySource, catalog: AppSession): Promise<{
  preview: ConversationAdoptionPreview
  seed: ConversationSeed
}> {
  const archive = await readTraceArchiveForMigration({ userDataDir: userData, cwd: source.cwd,
    providerId: source.providerId, sessionId: source.externalSessionId })
  if (!archive?.turns.length) throw new Error('没有可完整迁入的 App 捕获归档；旧入口保留')
  if (archive.turns.some(turn => !turn.done || turn.status !== 'completed' || turn.attachments?.length || turn.items.some(event => event.steer))) {
    throw new Error('迁移仅支持已完成的纯文本捕获；未收敛、失败、附件或 Steer 历史需先核查，旧入口保留')
  }
  const turns: ConversationSeed['turns'] = []
  for (const turn of archive.turns) {
    turns.push({ runId: turn.runId,
      items: await conversationItemsFromTrace({ userData, conversation: { cwd: source.cwd }, runId: turn.runId,
        userText: turn.userText, items: turn.items }),
      nativeItems: [],
      archive: { sessionId: source.externalSessionId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}) } })
  }
  const title = catalog.title ?? `迁入会话 ${source.externalSessionId.slice(0, 8)}`
  const fingerprint = createHash('sha256').update(JSON.stringify({ source, archive, turns, title,
    pinnedAt: catalog.pinnedAt, archivedAt: catalog.archivedAt })).digest('hex')
  return {
    preview: { source, fingerprint, title, turnCount: turns.length },
    seed: { target: { providerId: source.providerId, continuationKey: `unverified-legacy:${fingerprint}` },
      nativeSessionId: source.externalSessionId, retiredReason: '旧捕获未记录可证明的接续身份；后续需明确新建原生上下文',
      adoptionFingerprint: fingerprint, title, pinnedAt: catalog.pinnedAt, archivedAt: catalog.archivedAt, turns }
  }
}
