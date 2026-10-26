import { join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { readJson, writeJsonAtomic } from './io.js'
import { findRecordById, recordStoreStamp, listRecords } from './store.js'
import { type ManagedRecorderProviderId } from './managed-evidence.js'


export async function recordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  return await findRecordById(dataRoot, recordId)
}

/**
 * 本 session 已提交 providerTurnId → recordId 的派生缓存（可从 records 完整重建，不是事实源）。
 * `stamp` 是建缓存时看到的存储指纹：只有指纹仍然一致才允许用它作否定判断。
 */
interface ManagedProviderTurnIndex {
  schemaVersion: 1
  stamp: { count: number; maxSequence: number }
  providerTurnRecordIds: Record<string, string>
}

function providerTurnIndexPath(root: string): string {
  return join(root, 'provider-turn-index.json')
}

async function readProviderTurnIndex(
  dataRoot: string,
  root: string
): Promise<{ stamp: { count: number; maxSequence: number }; index: ManagedProviderTurnIndex | null }> {
  const stamp = await recordStoreStamp(dataRoot)
  const cached = await readJson<ManagedProviderTurnIndex>(providerTurnIndexPath(root))
  const fresh =
    cached?.schemaVersion === 1 &&
    !!cached.providerTurnRecordIds &&
    cached.stamp?.count === stamp.count &&
    cached.stamp?.maxSequence === stamp.maxSequence
  return { stamp, index: fresh ? cached : null }
}

/**
 * 全量扫描后重建缓存。`stamp` 必须是扫描前取的：扫描期间落地的新记录会让
 * 下一次指纹对不上，从而再重建一次——宁可多扫一次，不能把没看见的记录当成不存在。
 */
async function rebuildProviderTurnIndex(
  root: string,
  stamp: { count: number; maxSequence: number },
  records: readonly AgentTurnRecord[],
  provider: ManagedRecorderProviderId,
  sessionId: string
): Promise<void> {
  const providerTurnRecordIds: Record<string, string> = {}
  for (const record of records) {
    if (record.provider.id !== provider || record.sessionId !== sessionId || !record.providerTurnId) continue
    providerTurnRecordIds[record.providerTurnId] = record.recordId
  }
  await writeJsonAtomic(
    providerTurnIndexPath(root),
    { schemaVersion: 1, stamp, providerTurnRecordIds } satisfies ManagedProviderTurnIndex,
    { sync: false }
  )
}

/** 提交成功后增量推进缓存，否则每轮提交都会让下一轮退回全量扫描。 */
export async function advanceProviderTurnIndex(
  dataRoot: string,
  root: string,
  record: AgentTurnRecord
): Promise<void> {
  const cached = await readJson<ManagedProviderTurnIndex>(providerTurnIndexPath(root))
  if (cached?.schemaVersion !== 1 || !cached.providerTurnRecordIds) return
  await writeJsonAtomic(
    providerTurnIndexPath(root),
    {
      schemaVersion: 1,
      stamp: await recordStoreStamp(dataRoot),
      providerTurnRecordIds: {
        ...cached.providerTurnRecordIds,
        ...(record.providerTurnId ? { [record.providerTurnId]: record.recordId } : {})
      }
    } satisfies ManagedProviderTurnIndex,
    { sync: false }
  )
}

export async function recordByProviderTurnId(
  dataRoot: string,
  root: string,
  provider: ManagedRecorderProviderId,
  sessionId: string,
  providerTurnId: string
): Promise<AgentTurnRecord | undefined> {
  const { stamp, index } = await readProviderTurnIndex(dataRoot, root)
  if (index) {
    const recordId = index.providerTurnRecordIds[providerTurnId]
    // 缓存与 records 同鲜且不含该 providerTurnId → 可信的否定结论。
    if (!recordId) return undefined
    const record = await findRecordById(dataRoot, recordId)
    if (
      record &&
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
    ) return record
    // 缓存指向的记录已不自洽 → 落回权威全量扫描，不猜。
  }
  const records = await listRecords(dataRoot)
  const matches = records.filter(
    (record) =>
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
  )
  if (matches.length > 1) {
    throw new Error('managed recorder found multiple records for one provider turn')
  }
  await rebuildProviderTurnIndex(root, stamp, records, provider, sessionId)
  return matches[0]
}
