import type { PiSessionProof } from './pi-session-proof'
import { record, type JsonRecord } from './pi-shared'
import type { PiEntrySnapshot } from './pi-types'
import type { PiRpcProcess } from './pi-rpc'

function piEntrySnapshot(response: JsonRecord): PiEntrySnapshot {
  const data = record(response.data)
  const rows = data.entries
  const leafId = data.leafId
  if (!Array.isArray(rows) || !(leafId === null || typeof leafId === 'string')) {
    throw new Error('Pi RPC get_entries 返回了无效 session entry 快照')
  }
  const entries = rows.map(record)
  const entryIds = entries.map((entry) => entry.id)
  if (entryIds.some((id) => typeof id !== 'string' || !id) || new Set(entryIds).size !== entryIds.length) {
    throw new Error('Pi RPC get_entries 返回了无效或重复的 session entry id')
  }
  if (leafId === null && entries.length > 0) {
    throw new Error('Pi RPC get_entries 的空 leaf 与非空 entries 冲突')
  }
  if (leafId !== null && !entries.some((entry) => entry.id === leafId)) {
    throw new Error('Pi RPC get_entries 的 leafId 不在 session entries 中')
  }
  return { entries, leafId, appendCursor: entries.length > 0 ? entryIds.at(-1) as string : null }
}

function isUserMessageEntry(entry: JsonRecord): boolean {
  return entry.type === 'message' && record(entry.message).role === 'user'
}

export function piUserEntryIdAfterBaseline(
  baselineLeafId: string | null,
  entries: JsonRecord[],
  allowSteeringEntries = false
): string | null {
  const candidates = entries.filter(isUserMessageEntry)
  if (candidates.length === 0) return null
  if (!allowSteeringEntries && candidates.length !== 1) throw new Error('Pi RPC prompt 对应多个新增 user session entries')
  const root = candidates[0]
  if (typeof root.id !== 'string' || !root.id) throw new Error('Pi RPC prompt 的 user session entry 缺少稳定 id')
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const candidate of candidates) {
    let parentId = candidate.parentId
    const visited = new Set<string>()
    let reachedRoot = candidate === root
    while (parentId !== baselineLeafId) {
      if (typeof parentId !== 'string' || !parentId || visited.has(parentId)) {
        throw new Error('Pi RPC user session entry 无法回溯到 prompt 前冻结的 active leaf')
      }
      visited.add(parentId)
      if (parentId === root.id) reachedRoot = true
      const parent = byId.get(parentId)
      if (!parent) throw new Error('Pi RPC user session entry 的新增 ancestry 不完整')
      parentId = parent.parentId
    }
    if (!reachedRoot) throw new Error('Pi RPC prompt 对应多个 active branch user entries')
  }
  // get_entries uses append order. Only an actual Steer dispatch permits additional
  // users, all on the same ancestry. Expanded slash text must not select a later user.
  return root.id
}

async function piEntryBaseline(rpc: PiRpcProcess): Promise<PiEntrySnapshot> {
  return piEntrySnapshot(await rpc.send({ type: 'get_entries' }))
}

async function waitForPiUserEntryId(
  rpc: PiRpcProcess,
  baseline: PiEntrySnapshot,
  isSettled: () => boolean,
  hasSteerInput: () => boolean,
  exact?: PiSessionProof
): Promise<{ status: 'verified'; entryId: string } | { status: 'unavailable'; reason: string }> {
  for (;;) {
    let changed!: () => void
    let failed!: (error: Error) => void
    const activity = new Promise<void>((resolve, reject) => { changed = resolve; failed = reject })
    void activity.catch(() => undefined)
    // Subscribe before the snapshot so an event arriving during get_entries is not lost.
    const off = rpc.onEvent(changed)
    const offFailure = rpc.onFailure(failed)
    const terminalSnapshot = isSettled()
    try {
      const response = await rpc.send({
        type: 'get_entries',
        ...(baseline.appendCursor ? { since: baseline.appendCursor } : {})
      }, null)
      const rows = record(response.data).entries
      if (!Array.isArray(rows)) throw new Error('Pi RPC get_entries 返回了无效增量 entries')
      const id = piUserEntryIdAfterBaseline(
        baseline.leafId,
        rows.map(record),
        hasSteerInput()
      )
      if (id) {
        if (!exact) return { status: 'verified', entryId: id }
        const proof = await exact.verify(id)
        if (proof.status === 'matched') return { status: 'verified', entryId: id }
        if (proof.status === 'unavailable') return proof
      }
      // Only a post-settlement snapshot proves missing identity. Do not kill a running
      // Provider because its prompt entry has not appeared within an arbitrary five seconds.
      if (terminalSnapshot) throw new Error('Pi RPC prompt 已接受，但未出现 authoritative user session entry')
      await activity
    } finally {
      off()
      offFailure()
    }
  }
}


export { piEntrySnapshot, piEntryBaseline, waitForPiUserEntryId }
