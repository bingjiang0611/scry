import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

function processes() {
  // lstart order depends on locale (en_NZ uses day before month). Identity capture and
  // revalidation must parse the same stable format, without weakening signal checks.
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  const rows = new Map()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/)
    if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), status: match[3], started: match[4], command: match[5] })
  }
  return rows
}

function descendants(rows, root) {
  const owned = new Map()
  if (!rows.has(root)) return owned
  owned.set(root, rows.get(root))
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows.values()) {
      if (!owned.has(row.pid) && owned.has(row.parent)) {
        owned.set(row.pid, row)
        changed = true
      }
    }
  }
  return owned
}

function remaining(owned) {
  const current = processes()
  const live = []
  for (const identity of owned.values()) {
    const row = current.get(identity.pid)
    if (!row || row.started !== identity.started || row.status.startsWith('Z')) continue
    // Exit can race ps's command read. Read-only waiting tolerates that transient;
    // any actual signal still requires the original command identity below.
    live.push(row)
  }
  return live
}

async function waitForGone(owned, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let live = remaining(owned)
  while (live.length && Date.now() < deadline) {
    await delay(50)
    live = remaining(owned)
  }
  return live
}

function signalOwned(owned, signal) {
  // Revalidate registered identities immediately before each sweep. Never signal by name/cwd.
  for (const row of remaining(owned)) {
    if (row.command !== owned.get(row.pid).command) throw new Error(`owned process identity changed; refusing signal: ${JSON.stringify({ pid: row.pid, expected: owned.get(row.pid).command, observed: row.command, status: row.status })}`)
    try { process.kill(row.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

/** Test-only cleanup, outside Electron so the intentional SIGKILL cannot erase ownership. */
export async function stopOwnedApp(child, { crash = false } = {}) {
  if (!child) return { tracked: 0 }
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('test App exited before ownership capture; descendant cleanup unknown')
  const owned = descendants(processes(), child.pid)
  if (!owned.has(child.pid)) throw new Error('test App identity unavailable; refusing cleanup/restart')
  child.kill(crash ? 'SIGKILL' : 'SIGTERM')
  // A graceful App may close its descendants itself. Crash tests reclaim the saved children here.
  let live = await waitForGone(owned, crash ? 100 : 2_000)
  if (live.length) {
    signalOwned(owned, 'SIGTERM')
    live = await waitForGone(owned, 1_000)
  }
  if (live.length) {
    signalOwned(owned, 'SIGKILL')
    live = await waitForGone(owned, 2_000)
  }
  if (live.length) throw new Error(`test process exit unconfirmed: ${JSON.stringify({ root: child.pid,
    live: live.map(({ pid, parent, status, started, command }) => ({ pid, parent, status, started, command: command.slice(0, 512) })) })}`)
  return { tracked: owned.size }
}
