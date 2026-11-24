import { describe, expect, it } from 'vitest'
import {
  attributeProcessTree,
  cpuPercentBetween,
  cpuTimesFromCpus,
  parseMemoryPressureLevel,
  parseProcMeminfo,
  parsePsiMemory,
  parsePsTable,
  parseSwapUsage,
  parseVmStat
} from './host-metrics-parsers'

// Fixtures are the real command output shapes, trimmed. Each parser answers null
// rather than 0 when a field it needs is missing (P8 §3, §9).

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               45321.
Pages active:                            123456.
Pages inactive:                          234567.
Pages speculative:                         8901.
Pages wired down:                        345678.
Pages purgeable:                           1234.
`

describe('vm_stat', () => {
  it('counts available memory as free + inactive + speculative + purgeable', () => {
    const parsed = parseVmStat(VM_STAT)
    expect(parsed).not.toBeNull()
    expect(parsed!.pageSizeBytes).toBe(16384)
    expect(parsed!.availableBytes).toBe((45321 + 234567 + 8901 + 1234) * 16384)
  })

  it('refuses to guess when a page count or the page size is missing', () => {
    expect(parseVmStat('Pages free: 10.\nPages inactive: 20.\n')).toBeNull()
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\n')).toBeNull()
  })

  it('refuses output that is not vm_stat at all', () => {
    expect(parseVmStat('')).toBeNull()
    expect(parseVmStat('MemTotal: 1024 kB\n')).toBeNull()
  })
})

describe('memory pressure and swap', () => {
  it('maps the macOS pressure level, and refuses an unknown level', () => {
    expect(parseMemoryPressureLevel('1\n')).toBe('low')
    expect(parseMemoryPressureLevel('2\n')).toBe('medium')
    expect(parseMemoryPressureLevel('4\n')).toBe('high')
    expect(parseMemoryPressureLevel('3\n')).toBeNull()
    expect(parseMemoryPressureLevel('')).toBeNull()
  })

  it('reads used swap in bytes from sysctl vm.swapusage', () => {
    expect(parseSwapUsage('vm.swapusage: total = 4096.00M  used = 1228.88M  free = 2867.12M  (encrypted)'))
      .toEqual({ usedBytes: Math.round(1228.88 * 1024 * 1024), totalBytes: 4096 * 1024 ** 2 })
  })

  it('returns null for swap output without a used figure', () => {
    expect(parseSwapUsage('vm.swapusage: total = 0.00M  free = 0.00M')).toEqual({ usedBytes: null, totalBytes: 0 })
    expect(parseSwapUsage('')).toEqual({ usedBytes: null, totalBytes: null })
  })
})

describe('/proc/meminfo', () => {
  const MEMINFO = `MemTotal:       16316184 kB
MemFree:          234876 kB
MemAvailable:    7234560 kB
SwapTotal:       4194300 kB
SwapFree:        1290000 kB
`

  it('uses MemAvailable, not MemFree', () => {
    const parsed = parseProcMeminfo(MEMINFO)
    expect(parsed.totalBytes).toBe(16316184 * 1024)
    expect(parsed.availableBytes).toBe(7234560 * 1024)
    expect(parsed.swapUsedBytes).toBe((4194300 - 1290000) * 1024)
  })

  it('leaves an absent field null instead of substituting another one', () => {
    const parsed = parseProcMeminfo('MemTotal: 16316184 kB\nMemFree: 234876 kB\n')
    expect(parsed.totalBytes).toBe(16316184 * 1024)
    expect(parsed.availableBytes).toBeNull()
    expect(parsed.swapUsedBytes).toBeNull()
  })

  it('returns null total for junk input', () => {
    expect(parseProcMeminfo('').totalBytes).toBeNull()
  })
})

describe('PSI memory pressure', () => {
  it('maps avg10 onto the three levels', () => {
    expect(parsePsiMemory('some avg10=0.00 avg60=0.00 avg300=0.00 total=1')).toBe('low')
    expect(parsePsiMemory('some avg10=15.50 avg60=10.00 avg300=2.00 total=1')).toBe('medium')
    expect(parsePsiMemory('some avg10=55.00 avg60=40.00 avg300=30.00 total=1')).toBe('high')
  })

  it('returns null when there is no avg10 window', () => {
    expect(parsePsiMemory('')).toBeNull()
    expect(parsePsiMemory('full avg60=1.00 total=2')).toBeNull()
  })
})

describe('CPU deltas', () => {
  it('sums the per-core times and computes the busy share between two samples', () => {
    const first = cpuTimesFromCpus([
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }
    ] as never)
    const second = cpuTimesFromCpus([
      { times: { user: 200, nice: 0, sys: 100, idle: 1700, irq: 0 } }
    ] as never)
    expect(first).toEqual({ idle: 850, total: 1000 })
    expect(cpuPercentBetween(first, second)).toBe(15)
  })

  it('returns null when time did not advance or the samples are unusable', () => {
    const same = cpuTimesFromCpus([{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }] as never)
    expect(cpuPercentBetween(same, same)).toBeNull()
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 0 })).toBeNull()
  })
})

describe('ps table', () => {
  const PS = `    101     1  12000  0.5 /usr/bin/node
    102   101   8000  1.5 claude
    103   102   4000  7.5 claude
   not a row
`

  it('parses pid, ppid, resident kilobytes and percent CPU', () => {
    const rows = parsePsTable(PS)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual({ pid: 102, ppid: 101, rssBytes: 8000 * 1024, cpuPercent: 1.5, comm: 'claude' })
  })

  it('skips malformed lines instead of inventing rows', () => {
    expect(parsePsTable('')).toEqual([])
    expect(parsePsTable('not a row\n')).toEqual([])
  })
})

describe('process tree attribution', () => {
  const rows = parsePsTable(`    101     1  12000  0.5 node
    102   101   8000  1.5 claude
    103   102   4000  7.5 claude
    104   101   2000  0.5 codex
    105   101   1000  0.0 helper
    200     1   9000  9.0 claude
`)

  it('keeps only the daemon descendants, grouped by Provider', () => {
    const usage = attributeProcessTree(rows, 101, [])
    const byId = Object.fromEntries(usage.map((entry) => [entry.providerId, entry]))
    expect(byId.claude).toMatchObject({ processes: 2, cpuPercent: 9, rssBytes: 12_000 * 1024 })
    expect(byId.codex).toMatchObject({ processes: 1, cpuPercent: 0.5 })
    // 105 is a descendant but its executable names no Provider: 「其他」, not claude.
    expect(byId.other).toMatchObject({ processes: 1, cpuPercent: 0 })
    // 200 is not below the daemon at all.
    expect(usage.reduce((sum, entry) => sum + entry.processes, 0)).toBe(4)
  })

  it('prefers an explicit provider root over the executable name', () => {
    const usage = attributeProcessTree(rows, 101, [{ providerId: 'qoder', pid: 105 }])
    expect(usage.find((entry) => entry.providerId === 'qoder')).toMatchObject({ processes: 1, rssBytes: 1_000 * 1024 })
    expect(usage.find((entry) => entry.providerId === 'other')).toBeUndefined()
  })

  it('ignores a recorded root whose PID was reused outside the tree', () => {
    // W20-style attribution remembers pid 200, which now belongs to an unrelated process.
    const usage = attributeProcessTree(rows, 101, [{ providerId: 'codex', pid: 200 }])
    expect(usage.find((entry) => entry.providerId === 'codex')).toMatchObject({ processes: 1, cpuPercent: 0.5 })
    expect(usage.reduce((sum, entry) => sum + entry.processes, 0)).toBe(4)
  })

  it('returns nothing when the daemon has no children', () => {
    expect(attributeProcessTree(parsePsTable('  101   1  1000  0.1 node\n'), 101, [])).toEqual([])
  })

  it('leaves out the sampler commands the daemon itself started', () => {
    // 「机器」页打开时 daemon 会起 ps/sysctl/vm_stat 读数据。它们是 daemon 的直接子进程，
    // 但属于采样本身，不能算进「Scry 占用」，否则「其他」会凭空多出进程和内存。
    const table = parsePsTable(`  101     1  12000  0.5 node
  110   101   1840  0.2 ps
  111   101   1200  0.0 sysctl
  102   101   8000  1.5 claude
  112   102   1840  0.0 ps
`)
    const usage = attributeProcessTree(table, 101, [])
    // Provider 自己起的 ps 仍在（它在 claude 下面，不是 daemon 的直接子进程）。
    expect(usage).toEqual([{ providerId: 'claude', processes: 2, cpuPercent: 1.5, rssBytes: 9840 * 1024 }])
  })
})
