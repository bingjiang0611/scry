import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'

/**
 * A process that was running when a turn opened, identified by pid and by a token that changes when
 * the pid is recycled (Linux start ticks, macOS `lstart`). A record that inherited no pid, or a
 * machine whose table cannot be read, yields nothing: the caller then has no evidence either way.
 */
export interface HostProcess {
  pid: number
  /** Stable for one boot. Absent when the platform did not report it. */
  token?: string
}

export interface ProcessTableEntry extends HostProcess {
  ppid: number
}

/**
 * The installed hook runs as `sh -c '<command>'`, which execs `.scry/provider-hook.sh`, so the
 * Provider is the third process from the script: script → wrapper shell → host. Walking further
 * reaches the terminal or the window server, which outlive the session by design and would veto
 * every expiry forever. A deeper wrapper chain therefore yields no host evidence at all — which is
 * the safe direction, because the silence window still decides on its own.
 */
const MAX_DEPTH = 3

/**
 * The processes a turn's host sits in, nearest first. Only an observation: the caller decides what a
 * live or dead ancestor means. `seed` is the pid of the process that delivered the event — the
 * hook's own ancestry is the host's ancestry only when the recorder ran inside it.
 */
export async function hostProcessChain(seed: number, depth = MAX_DEPTH): Promise<HostProcess[]> {
  const table = await processTable()
  if (!table) return []
  const chain: HostProcess[] = []
  const seen = new Set<number>()
  let pid = Number.isInteger(seed) && seed > 0 ? seed : undefined
  for (let step = 0; step < depth && pid !== undefined; step++) {
    if (seen.has(pid)) break
    seen.add(pid)
    const entry = table.get(pid)
    if (!entry) break
    // Init is alive as long as the machine is; recording it would make every turn unexpirable.
    if (entry.pid > 1) chain.push({ pid: entry.pid, ...(entry.token ? { token: entry.token } : {}) })
    // Init, launchd and the kernel all point at themselves; the chain ends where it stops moving.
    if (entry.ppid === entry.pid || entry.ppid <= 1) break
    pid = entry.ppid
  }
  return chain
}

/**
 * Which of these processes are still the same process, not a recycled pid. `undefined` means the
 * table could not be read — an unanswered question, never a "no".
 */
export async function liveHostProcesses(
  chain: HostProcess[],
  known?: Map<number, ProcessTableEntry>
): Promise<HostProcess[] | undefined> {
  if (!chain.length) return []
  const table = known ?? await processTable()
  if (!table) return undefined
  const live: HostProcess[] = []
  for (const recorded of chain) {
    const current = table.get(recorded.pid)
    if (!current) continue
    // A token on one side only cannot prove a match; a differing token proves a different process.
    if (recorded.token && current.token && recorded.token !== current.token) continue
    live.push(recorded)
  }
  return live
}

/** The whole process table, or `undefined` when this platform has no readable one. */
export async function processTable(): Promise<Map<number, ProcessTableEntry> | undefined> {
  return await procTable() ?? await psTable()
}

/** Linux: every field comes from `/proc`, which costs no process spawn. */
async function procTable(): Promise<Map<number, ProcessTableEntry> | undefined> {
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return undefined
  }
  const table = new Map<number, ProcessTableEntry>()
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    // A process can exit between the directory listing and this read; that is not an error.
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined)
    if (!stat) continue
    // `comm` may contain spaces and parentheses: fields after the last ')' are positionally stable.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(fields[1])
    const token = fields[19]
    const pid = Number(name)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { pid, ppid, ...(token ? { token: `ticks:${token}` } : {}) })
  }
  return table.size ? table : undefined
}

/** macOS and other POSIX systems: one `ps` call for the whole table. */
async function psTable(): Promise<Map<number, ProcessTableEntry> | undefined> {
  const stdout = await new Promise<string | undefined>((resolvePromise) => {
    execFile('ps', ['-axo', 'pid=,ppid=,lstart='], { maxBuffer: 8 * 1024 * 1024, timeout: 5_000 }, (error, out) =>
      resolvePromise(error ? undefined : String(out)))
  })
  if (!stdout) return undefined
  const table = new Map<number, ProcessTableEntry>()
  for (const line of stdout.split('\n')) {
    // `lstart` is five fixed-width fields ("Thu Nov 16 08:02:34 2026"); pids come first.
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { pid, ppid, token: match[3].trim() })
  }
  return table.size ? table : undefined
}

/**
 * Whether the processes that hosted this turn at start are still running.
 *
 * Only `gone` is proof: every recorded process was observed to be the same process and none of them
 * exists. `running` means the host may still deliver events, and `unknown` means no chain was
 * recorded or the table could not be read. Both of those refuse forced expiry — silence is not a
 * statement about a process, so a turn with no host evidence stays open.
 */
export type HostProcessState = 'running' | 'gone' | 'unknown'

export async function hostProcessState(
  host: HostProcess[] | undefined,
  table?: Map<number, ProcessTableEntry>
): Promise<HostProcessState> {
  if (!host?.length) return 'unknown'
  const live = await liveHostProcesses(host, table)
  if (!live) return 'unknown'
  return live.length ? 'running' : 'gone'
}
