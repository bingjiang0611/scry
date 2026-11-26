import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dist, manifestPath, mode] = process.argv.slice(2)
if (!dist || !manifestPath || (mode && mode !== '--pin')) throw new Error('usage: replay-qoder-stop-samples <CLI dist> <manifest> [--pin]')
const load = name => import(pathToFileURL(resolve(dist, 'core/turn-recorder', `${name}.js`)))
const { stableTranscript } = await load('recorder-transcript-cache')
const { qoderTranscriptReplyComplete } = await load('qoder-stop-evidence')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const lags = [0, 1000, 5000, 10000]
const samples = mode === '--pin' ? undefined : new Map(JSON.parse(await readFile(manifestPath, 'utf8')).map(row => [row.id, row]))
const pinned = new Map()
const results = Object.fromEntries(lags.map(ms => [ms, { complete: 0, committedPartial: 0, pending: 0, deadlineDegraded: 0, reasons: {} }]))
const unresolved = { backgroundHeld: 0, noMatchingTurnAtDeadline: 0, matchingTurnMissingFinalReply: 0 }
const knownReasons = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'complete', 'completed', 'stop', 'tool_use'])
for await (const line of createInterface({ input: process.stdin })) {
  const sample = JSON.parse(line)
  const { path, cwd, sessionId, requestSetId, prompt, hookLogAt } = sample
  const id = sha256(JSON.stringify([sessionId, requestSetId, hookLogAt]))
  if ((samples && !samples.has(id)) || pinned.has(id)) continue
  const bytes = await readFile(path)
  const clocks = []
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(10, offset)
    if (newline < 0) break
    try {
      const timestamp = Date.parse(JSON.parse(bytes.subarray(offset, newline)).timestamp)
      if (Number.isFinite(timestamp)) clocks.push({ timestamp, offset })
    } catch {}
    offset = newline + 1
  }
  const ends = lags.map(lag => clocks.find(row => row.timestamp > hookLogAt + lag)?.offset ?? bytes.length)
  const summary = { id, opening: sha256(prompt), prefixes: ends.map(end => sha256(bytes.subarray(0, end))) }
  if (samples && JSON.stringify(samples.get(id)) !== JSON.stringify(summary)) throw new Error(`digest changed for sample ${id}`)
  pinned.set(id, summary)
  let settlement
  let backgroundHeld = false
  for (const [index, lag] of lags.entries()) {
    const read = await stableTranscript(path, id, 'qoder', summary.opening, undefined, 0, requestSetId, sessionId, cwd, undefined, ends[index])
    const counts = results[lag]
    const reason = read.stopReason ? knownReasons.has(read.stopReason) ? read.stopReason : 'other' : 'missing'
    counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1
    if (!lag && read.pendingBackgroundTasks?.length) backgroundHeld = true
    if (!settlement && !backgroundHeld) {
      if (read.identityMatched === true && qoderTranscriptReplyComplete(read)) {
        settlement = read.complete ? 'complete' : 'committedPartial'
      } else if (lag === 10000) {
        settlement = 'deadlineDegraded'
        if (read.identityMatched === true) unresolved.matchingTurnMissingFinalReply++
        else unresolved.noMatchingTurnAtDeadline++
      }
    }
    counts[settlement ?? 'pending']++
  }
  if (backgroundHeld) unresolved.backgroundHeld++
}
if (samples && pinned.size !== samples.size) throw new Error(`found ${pinned.size} of ${samples.size} pinned samples`)
if (mode === '--pin') {
  if (pinned.size !== 59) throw new Error(`expected the accepted 59-sample set, found ${pinned.size}`)
  await writeFile(manifestPath, JSON.stringify([...pinned.values()].sort((a, b) => a.id.localeCompare(b.id)), null, 2) + '\n', { flag: 'wx' })
}
console.log(JSON.stringify({ samples: pinned.size, results, unresolved }))
