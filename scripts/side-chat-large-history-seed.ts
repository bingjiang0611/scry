/**
 * Seeds one large parent conversation into an isolated userData directory.
 *
 * The App-level large-history acceptance must exercise a parent far past the old
 * ceilings: more than 2000 turns, more than 4000 messages, a >16 MiB archive and a
 * >4 MiB visible message. Preparing that through thousands of real Provider runs is
 * fixture cost, not acceptance value: the checks under test are the shipped preview,
 * creation, first send and the Provider's real history-reader reads. So this script
 * writes the same canonical on-disk facts the recorder writes — per-turn archive
 * segments at the production path and one conversation record — through the
 * production store and archive modules, and nothing else.
 *
 * It runs in the packaged-App smoke's temporary userData only, never inside the App.
 */
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { ConversationStore } from '../src/main/conversation-store'
import { traceArchiveTurnPath } from '../src/main/transcript-archive'
import type { ProviderId } from '../src/shared/provider'
import type { ConversationItemRef } from '../src/shared/conversation'
import type { TraceEvent } from '../src/shared/trace'

const MiB = 1024 * 1024
/** One visible message past the removed 4 MiB body budget. */
export const HUGE_MESSAGE_BYTES = 4 * MiB + 64 * 1024
export const SMALL_TURNS = 2000
export const HUGE_TURNS = 5

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const textEvent = (runId: string, text: string): TraceEvent => ({
  id: `${runId}:text`, runId, ts: '2026-10-02T00:00:00.000Z', kind: 'model', stage: 'text', text
})

export interface LargeHistorySeed {
  conversationId: string
  cwd: string
  providerId: ProviderId
  nativeSessionId: string
  turnCount: number
  messageCount: number
  archiveBytes: number
  hugeMessageBytes: number
  hugeOrdinal: number
  /**
   * The hash the fixture wrote for every frozen message, in frozen order. A read body is
   * compared with this, so the reader cannot prove itself right by reading again.
   */
  itemHashes: string[]
  /** The first message text in frozen order, for the dialog's own content check. */
  firstMessageText: string
}

export async function seedLargeHistory(input: {
  userData: string
  workspace: string
  providerId?: ProviderId
}): Promise<LargeHistorySeed> {
  const providerId = input.providerId ?? 'codex'
  await mkdir(input.workspace, { recursive: true })
  // The App keys its archive and records by the canonical workspace path.
  const cwd = await realpath(input.workspace)
  const store = new ConversationStore(input.userData)
  const nativeSessionId = 'large-history-parent'
  const turns: Array<{ runId: string; items: ConversationItemRef[]; nativeItems: ConversationItemRef[]; archive: { sessionId: string; providerTurnId: string } }> = []
  let archiveBytes = 0
  const itemHashes: string[] = []
  let hugeMessageBytes = 0
  let hugeOrdinal = 0
  const prompts = Array.from({ length: SMALL_TURNS }, (_unused, index) => `large history turn ${index}`)
  for (let index = 0; index < HUGE_TURNS; index += 1) {
    prompts.push(`大历史结尾 ${index} ${'大'.repeat(Math.ceil(HUGE_MESSAGE_BYTES / 3))}`)
  }
  for (const [index, prompt] of prompts.entries()) {
    const runId = `seed-run-${index}`
    const answer = `large history answer ${index}`
    const providerTurnId = `seed-turn-${index}`
    const path = traceArchiveTurnPath(input.userData, cwd, nativeSessionId, providerId, { runId, providerTurnId })
    await mkdir(dirname(path), { recursive: true })
    // Canonical split segment: exactly one turn in the production archive document.
    await writeFile(path, JSON.stringify({
      version: 3, cwd, sessionId: nativeSessionId, providerId, runtimeProvider: `${providerId}_cli`,
      turns: [{ runId, providerTurnId, userText: prompt, items: [textEvent(runId, answer)],
        done: true, status: 'completed', ts: Date.now() }]
    }))
    archiveBytes += (await stat(path)).size
    const promptBytes = Buffer.byteLength(prompt, 'utf8')
    if (promptBytes > hugeMessageBytes) {
      hugeMessageBytes = promptBytes
      hugeOrdinal = index + 1
    }
    itemHashes.push(hash(prompt), hash(answer))
    turns.push({
      runId,
      items: [{ runId, itemId: 'user', contentHash: hash(prompt) }, { runId, itemId: 'assistant', contentHash: hash(answer) }],
      nativeItems: [],
      archive: { sessionId: nativeSessionId, providerTurnId }
    })
  }
  const conversation = await store.create(cwd, {
    target: { providerId, continuationKey: `identity:${providerId}:default` },
    nativeSessionId,
    title: 'Large history parent',
    turns
  })
  // The App only reads an archive under a workspace its own project authority knows, so
  // the fixture registers the same session catalog row a real run would have left.
  const sessionsPath = join(input.userData, 'app-sessions.json')
  const sessions = await readFile(sessionsPath, 'utf8').then(value => JSON.parse(value) as unknown[]).catch(() => [])
  await writeFile(sessionsPath, JSON.stringify([...sessions, {
    sessionId: nativeSessionId, externalSessionId: nativeSessionId, runId: 'seed-run-0',
    providerId, runtimeProvider: `${providerId}_cli`, cwd, preview: 'Large history parent',
    // Old enough that the App's own session ordering never opens this fixture project first.
    ts: Date.now() - 7 * 24 * 60 * 60 * 1000
  }]))
  // This workspace is not the App's current project: only the project authority needs it,
  // and the fixture must not change which project the App opens.
  // The reader picks these three positions in frozen order; the fixture wrote them, so the
  // comparison is against the source, not against another read of the same authority.
  const seed: LargeHistorySeed = {
    conversationId: conversation.id, cwd, providerId, nativeSessionId,
    turnCount: turns.length, messageCount: turns.length * 2, archiveBytes, hugeMessageBytes, hugeOrdinal,
    itemHashes,
    firstMessageText: prompts[0]
  }
  // The fixture is only useful if it really exceeds every removed ceiling.
  if (seed.turnCount <= 2000) throw new Error(`fixture needs >2000 turns, got ${seed.turnCount}`)
  if (seed.messageCount <= 4000) throw new Error(`fixture needs >4000 messages, got ${seed.messageCount}`)
  if (seed.archiveBytes <= 16 * MiB) throw new Error(`fixture needs a >16 MiB archive, got ${seed.archiveBytes}`)
  if (seed.hugeMessageBytes <= 4 * MiB) throw new Error(`fixture needs a >4 MiB message, got ${seed.hugeMessageBytes}`)
  return seed
}

// A temporary macOS path can be reached through a symlink, so compare real paths.
const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
  const userData = args.get('--user-data')
  const workspace = args.get('--workspace')
  const out = args.get('--out')
  if (!userData || !workspace || !out) throw new Error('usage: --user-data <dir> --workspace <dir> --out <json>')
  const seed = await seedLargeHistory({ userData, workspace })
  await writeFile(out, JSON.stringify(seed))
  console.log(JSON.stringify(seed))
}
