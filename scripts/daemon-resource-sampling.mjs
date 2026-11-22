import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { daemonHolder } from './b4v/fixture.mjs'
import { readIdentity, readProcessEnv, verifyHolder } from './b4v/process-identity.mjs'

const unavailable = reason => ({ status: 'unavailable', reason })

// macOS ps uses M:SS.hh; Linux uses [DD-]HH:MM:SS. Values are cumulative CPU
// for this lock holder only. RSS is one point sample, with no peak claim.
export function sampleDaemonResources(userData) {
  const daemonState = join(userData, 'daemon')
  const holder = daemonHolder({ daemonState })
  if (holder.verdict !== 'verified') return unavailable(holder.verdict)
  const { pid } = holder.lock
  const env = readProcessEnv(pid, ['SCRY_DAEMON_STATE_DIR', 'SCRY_DAEMON_USER_DATA_DIR'])
  if (env.status !== 'available') return unavailable('daemon process environment unavailable')
  if (env.env.SCRY_DAEMON_STATE_DIR !== daemonState || env.env.SCRY_DAEMON_USER_DATA_DIR !== userData) {
    return unavailable('daemon process belongs to a different fixture')
  }

  let output
  try {
    output = execFileSync('/bin/ps', ['-o', 'rss=,time=', '-p', String(pid)], {
      env: { LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    return unavailable('daemon process resources unavailable from ps')
  }
  if (verifyHolder(holder.lock, readIdentity(pid)) !== 'verified') {
    return unavailable('daemon identity changed while sampling')
  }
  const match = /^(\d+)\s+(?:(\d+)-)?(\d+(?::\d+){1,2}(?:\.\d+)?)$/.exec(output.trim())
  if (!match) return unavailable('daemon process resources could not be parsed')
  const seconds = match[3].split(':').reduce((total, field) => total * 60 + Number(field), 0)
  return {
    status: 'measured', pid, startedAt: holder.identity.startedAt, sampledAtEpochMs: Date.now(),
    rssBytes: Number(match[1]) * 1024, cpuTimeMs: Math.round((Number(match[2] ?? 0) * 86400 + seconds) * 1000)
  }
}

export function noteMissingDaemonSamples(bench, samples) {
  for (const [label, sample] of Object.entries(samples)) {
    if (sample.status === 'unavailable') console.error(`[${bench}] 未采 daemon (${label}): ${sample.reason}`)
  }
}
