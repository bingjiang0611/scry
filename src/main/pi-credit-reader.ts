import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hashNativeFile, locatePiNativeSession, nativeLines, PiNativeHistoryStaleError } from './pi-native-history'
import { piCreditEntries, type PiCreditEntry } from './pi-credit-usage'

function compactEntry(entry: PiCreditEntry): PiCreditEntry {
  const data = entry.customType === 'qoder-credit-observation-v1' ? entry.data : undefined
  return {
    type: entry.type, id: entry.id, parentId: entry.parentId,
    version: entry.version, cwd: entry.cwd, customType: entry.customType,
    message: entry.message ? { role: entry.message.role, provider: entry.message.provider } : undefined,
    data: data ? { version: data.version, sessionId: data.sessionId, requestId: data.requestId,
      modelId: data.modelId, status: data.status, outcome: data.outcome, billable: data.billable, credits: data.credits } : undefined
  }
}

/** Receipt paths are adapter-owned; offline paths are catalog-authorized. Freeze the
 * initial byte range so live appends cannot extend the scan indefinitely. Memory is
 * bounded by one native record (64 MiB) plus at most one million compact entries.
 * Analytics shares the entry budget across its missing sessions. If this bound is
 * reached, report unavailable; a persistent offset index is needed before raising it. */
export async function readPiCreditRequests(args: {
  cwd: string
  sessionId: string
  turns: Array<{ runId: string; providerTurnId?: string }>
  sessionFile?: string
  sessionRoot?: string
  budget?: { remainingEntries: number }
}): Promise<ReturnType<typeof piCreditEntries>> {
  const path = args.sessionFile ?? (await locatePiNativeSession({
    cwd: args.cwd, sessionId: args.sessionId,
    sessionRoot: args.sessionRoot ?? join(homedir(), '.pi', 'agent', 'sessions')
  }))?.canonical
  if (!path) throw new Error('Pi credit session is unavailable in the default session root')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Pi credit session is not a regular file')
    const budget = args.budget ?? { remainingEntries: 1_000_000 }
    const entries: PiCreditEntry[] = []
    let incomplete = false
    const scannedHash = createHash('sha256')
    for await (const { line } of nativeLines(file, info.size, undefined, 0, scannedHash)) {
      const text = line.toString('utf8').trim()
      if (!text) continue
      if (entries.length >= 1_000_000 || budget.remainingEntries <= 0) throw new Error('Pi credit entry budget reached')
      budget.remainingEntries--
      let entry: PiCreditEntry
      try { entry = JSON.parse(text) as PiCreditEntry }
      catch (error) {
        // Only a malformed final unterminated record is a live tail. Corrupt
        // completed lines, oversized records and I/O failures never yield credits.
        if (!(error instanceof SyntaxError) || line.at(-1) === 10) throw error
        incomplete = true
        break
      }
      entries.push(compactEntry(entry))
    }
    // A growing live tail is allowed, but a rewrite must not combine revisions.
    const verified = await hashNativeFile(file, info.size, 0)
    if (verified.contentHash !== scannedHash.digest('hex')) throw new PiNativeHistoryStaleError()
    return piCreditEntries(entries, args, args.turns, incomplete)
  } finally { await file.close() }
}
