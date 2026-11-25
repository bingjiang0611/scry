import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'

export interface HostProcess {
  pid: number
  token?: string
}

export interface ProcessTableEntry extends HostProcess {
  ppid: number
}

const MAX_DEPTH = 3
const C_LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/

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
    if (entry.pid > 1) chain.push({ pid: entry.pid, ...(entry.token ? { token: entry.token } : {}) })
    if (entry.ppid === entry.pid || entry.ppid <= 1) break
    pid = entry.ppid
  }
  return chain
}

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
    if (recorded.token && current.token && recorded.token !== current.token) {
      if (!/^ticks:\d+$/.test(recorded.token) && !C_LSTART.test(recorded.token)) return undefined
      continue
    }
    live.push(recorded)
  }
  return live
}

export async function processTable(): Promise<Map<number, ProcessTableEntry> | undefined> {
  return await procTable() ?? await psTable()
}

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
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined)
    if (!stat) continue
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(fields[1])
    const token = fields[19]
    const pid = Number(name)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { pid, ppid, ...(token ? { token: `ticks:${token}` } : {}) })
  }
  return table.size ? table : undefined
}

async function psTable(): Promise<Map<number, ProcessTableEntry> | undefined> {
  let stdout: string | undefined
  try {
    stdout = await new Promise<string | undefined>((resolvePromise) => {
      execFile('ps', ['-axo', 'pid=,ppid=,lstart='], {
        maxBuffer: 8 * 1024 * 1024, timeout: 5_000, env: { ...process.env, LC_ALL: 'C' }
      }, (error, out) => resolvePromise(error ? undefined : String(out)))
    })
  } catch {
    return undefined
  }
  if (!stdout) return undefined
  const table = new Map<number, ProcessTableEntry>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { pid, ppid, token: match[3].trim() })
  }
  return table.size ? table : undefined
}

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
