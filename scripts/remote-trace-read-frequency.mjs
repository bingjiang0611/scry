#!/usr/bin/env node
// L1 count, not a millisecond measurement.
//
// How often does a device that follows one run re-read that run's trace content?
// The scenario is fixed so two refs are comparable: the run produces a ledger
// event batch every 100 ms for 60 s (600 change reports), the device is on the
// screen showing that run, and every poll cycle is assumed to take no time. The
// policy — poll interval, and whether a change report forces a read — is read from
// the renderer source at each ref, so this counts what the shipped code decides
// rather than what a test stub decides.
//
// Usage:
//   node scripts/remote-trace-read-frequency.mjs                # working tree
//   node scripts/remote-trace-read-frequency.mjs --ref aada148  # baseline
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const WINDOW_MS = 60_000
const CHANGE_EVERY_MS = 100
const refArgumentIndex = process.argv.indexOf('--ref')
const ref = refArgumentIndex > 0 ? process.argv[refArgumentIndex + 1] : undefined

function source(relative) {
  return ref
    ? execFileSync('git', ['show', `${ref}:${relative}`], { encoding: 'utf8' })
    : readFileSync(relative, 'utf8')
}

const shared = source('src/renderer/components/RemoteChatShared.ts')
const controls = source('src/renderer/components/RemoteChatControls.tsx')
const readNumber = (name) => {
  const match = shared.match(new RegExp(`export const ${name} = ([0-9_]+)`))
  if (!match) throw new Error(`${name} not found in RemoteChatShared.ts at ${ref ?? 'working tree'}`)
  return Number(match[1].replace(/_/g, ''))
}

const pollMs = readNumber('POLL_MS')
// A ref without the floor has no notion of coalescing: every change reads.
const floorMs = /export const TRACE_REFRESH_FLOOR_MS = ([0-9_]+)/.test(shared) ? readNumber('TRACE_REFRESH_FLOOR_MS') : 0
// `changed` forcing a read is the pre-coalescing shape: `changed !== true` was the
// only case the floor suppressed.
const changeForcesRead = /needsTraceRead\(state: \{[^}]*changed\?: boolean/.test(shared)

let now = 0
let lastReadAt = Number.NEGATIVE_INFINITY
let reads = 0
let polls = 0
while (now < WINDOW_MS) {
  polls += 1
  // The change reports are autonomous: what matters is whether this poll cycle
  // sees one, which is true whenever a batch landed since the previous cycle.
  const changed = now % CHANGE_EVERY_MS < pollMs
  const insideFloor = now - lastReadAt < floorMs
  if (!insideFloor || (changeForcesRead && changed)) {
    reads += 1
    lastReadAt = now
  }
  now += pollMs
}

const perMinute = Math.round((reads / WINDOW_MS) * 60_000)
console.log(JSON.stringify({
  ref: ref ?? 'working tree',
  level: 'L1 count of renderer trace reads',
  workload: `one followed run, one ledger batch every ${CHANGE_EVERY_MS} ms, ${WINDOW_MS / 1000} s window`,
  pollMs,
  floorMs,
  changeForcesRead,
  polls,
  reads,
  readsPerMinute: perMinute
}))
