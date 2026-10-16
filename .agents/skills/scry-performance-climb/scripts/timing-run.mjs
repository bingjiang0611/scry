#!/usr/bin/env node
// Run one timing measurement (millisecond bench, native App bench, soak) under a host-wide
// lock, recording system load before and after. Several agents on one machine must not time
// at the same moment: each would measure the others' load. Work counters do not need this.
//
//   node timing-run.mjs <label> -- <command> [args...]
//
// Exit 75 when another timing run holds the lock (retry later; do not run concurrently).
// The final stdout line is `SCRY_TIMING_RUN=<json>`; `highLoad: true` means the 1-minute load
// exceeded the core count at the start or end, so millisecond conclusions are not trustworthy.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'

// Fixed path: agents may run with different TMPDIR values but share the same host.
const lock = '/tmp/scry-performance-timing.lock'
const separator = process.argv.indexOf('--')
const label = process.argv[2]
const command = separator > 0 ? process.argv.slice(separator + 1) : []
if (!label || separator !== 3 || command.length === 0) {
  console.error('Usage: timing-run.mjs <label> -- <command> [args...]')
  process.exit(2)
}

const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function acquire() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock)
      writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, label, cwd: process.cwd(), startedAt: new Date().toISOString() }))
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try { owner = JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8')) } catch {}
      // Only a lock whose recorded owner process is gone is stale; an unreadable owner file may
      // be mid-write by a live owner, so it is never stolen.
      if (owner && Number.isInteger(owner.pid) && !alive(owner.pid)) { rmSync(lock, { recursive: true, force: true }); continue }
      console.error(`Another timing run holds ${lock}: ${owner ? JSON.stringify(owner) : 'owner unknown'}`)
      process.exit(75)
    }
  }
  console.error(`Could not acquire ${lock}`)
  process.exit(75)
}

const load = () => Number(loadavg()[0].toFixed(2))
const cores = cpus().length
acquire()
const release = () => rmSync(lock, { recursive: true, force: true })
const loadBefore = load()
const startedAt = Date.now()
const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => { release(); console.error(error.message); process.exit(1) })
child.once('exit', (code, signal) => {
  const loadAfter = load()
  release()
  const result = { label, command, exit: code, signal, wallMs: Date.now() - startedAt, cores, loadBefore, loadAfter, highLoad: loadBefore > cores || loadAfter > cores }
  console.log(`SCRY_TIMING_RUN=${JSON.stringify(result)}`)
  process.exit(code ?? 1)
})
