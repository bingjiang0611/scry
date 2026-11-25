import { join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { readJson, writeJsonAtomic } from './io.js'
import { findRecordById, recordStoreStamp, listRecords } from './store.js'
import { type ManagedRecorderProviderId } from './managed-evidence.js'


export async function recordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  return await findRecordById(dataRoot, recordId)
}

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
    if (!recordId) return undefined
    const record = await findRecordById(dataRoot, recordId)
    if (
      record &&
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
    ) return record
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
