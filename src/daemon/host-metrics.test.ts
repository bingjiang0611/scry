import { describe, expect, it, vi } from 'vitest'
import {
  HostMetricsSampler,
  createHostMetricsSources,
  type HostMetricsSources
} from './host-metrics'
import { HOST_METRICS_CACHE_MS, HOST_METRICS_MAX_BYTES, HOST_METRICS_MIN_INTERVAL_MS, hostMetricsWithinBound, type HostMetricsSnapshot } from '../shared/host-metrics'

// A machine whose every read is a fixture: what the sampler does with the reads is
// the subject, not the operating system.
function sources(overrides: Partial<HostMetricsSources> = {}): HostMetricsSources & {
  sleeps: number[]
  advance: (ms: number) => void
} {
  let clock = 1_700_000_000_000
  let cpuIdle = 1000
  let cpuTotal = 2000
  const sleeps: number[] = []
  const base: HostMetricsSources = {
    platform: 'darwin',
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    cpuTimes: () => ({ idle: cpuIdle, total: cpuTotal }),
    cores: 10,
    load1: () => 4.1,
    uptimeSec: () => 3 * 86400,
    totalBytes: () => 16 * 1024 ** 3,
    memoryText: async () => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages inactive: 200.
Pages speculative: 50.
Pages purgeable: 50.`,
    pressureText: async () => '2',
    swapText: async () => 'vm.swapusage: total = 4096.00M  used = 1024.00M  free = 3072.00M',
    processTable: async () => `  900  1  12000  0.8 node\n  901  900  8000  1.5 claude\n`,
    diskRoots: () => [{ role: 'data', path: '/data' }, { role: 'workspace', path: '/work' }, { role: 'workspace', path: '/work/project' }],
    statfs: (path) => path === '/data' ? { totalBytes: 1_000, freeBytes: 400 } : { totalBytes: 2_000, freeBytes: 1_900 },
    volumeId: (path) => path.startsWith('/data') ? 'data-vol' : 'work-vol',
    daemonCpuUsage: () => ({ user: 0, system: 0 }),
    daemonRss: () => 210 * 1024 ** 2,
    daemonPid: () => 900,
    providerRoots: () => [],
    activeRuns: () => ({ active: 2, queued: 1 }),
    ...overrides
  }
  return Object.assign(base, {
    sleeps,
    advance: (ms: number) => { clock += ms },
    // The sampler reads cpuTimes once per sample; keep the second read advanced.
    setCpu: (idle: number, total: number) => { cpuIdle = idle; cpuTotal = total }
  } as never)
}

describe('HostMetricsSampler', () => {
  it('keeps a crowded host inside the 8 KiB protocol bound', async () => {
    // 最坏情况：Provider 行已经堆到上限、四个盘、每台机器的字段都填满。
    const providers = Array.from({ length: 40 }, (_, index) => `  90${index}  9000  4294967296  ${index}.5  provider${index}\n`).join('')
    const src = sources({
      processTable: async () => `  9000  1  1  0.1  scry\n${providers}`,
      diskRoots: () => ['/data', '/work', '/work/a', '/work/b'].map((path, index) => ({ role: index === 0 ? 'data' as const : 'workspace' as const, path })),
      statfs: () => ({ totalBytes: 1_000_000_000_000, freeBytes: 500_000_000_000 }),
      volumeId: (path) => path,
      providerRoots: () => Array.from({ length: 40 }, (_, index) => ({ providerId: `provider-${index}-with-a-long-name`, pid: 900 + index }))
    })
    const sampler = new HostMetricsSampler(src)
    const reading = await sampler.read('remote')
    expect(hostMetricsWithinBound(reading)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(reading), 'utf8')).toBeLessThanOrEqual(HOST_METRICS_MAX_BYTES)
  })

  it('assembles every field from the injected reads', async () => {
    const src = sources() as never as HostMetricsSources & { setCpu: (a: number, b: number) => void }
    const sampler = new HostMetricsSampler(src)
    const reading = sampler.read('local')
    // Cold start: the second CPU sample happens 500 ms later, after the first read.
    src.setCpu(1500, 3000)
    const snapshot = await reading
    expect(snapshot.cpu).toEqual({ percent: 50, cores: 10, load1: 4.1 })
    expect(snapshot.memory).toEqual({
      totalBytes: 16 * 1024 ** 3, usedBytes: (16 * 1024 ** 3) - (400 * 16384), pressure: 'medium',
      swapUsedBytes: 1024 * 1024 ** 2, swapTotalBytes: 4096 * 1024 ** 2
    })
    expect(snapshot.uptimeSec).toBe(3 * 86400)
    // /work/project is the same volume as /work: one row, first role wins.
    expect(snapshot.disks).toEqual([
      { role: 'data', totalBytes: 1_000, freeBytes: 400 },
      { role: 'workspace', totalBytes: 2_000, freeBytes: 1_900 }
    ])
    expect(snapshot.scry.daemon).toEqual({ cpuPercent: null, rssBytes: 210 * 1024 ** 2, pid: 900 })
    // 900 is the daemon itself; only its child below it counts toward Provider usage.
    expect(snapshot.scry.providers).toEqual([
      { providerId: 'claude', processes: 1, cpuPercent: 1.5, rssBytes: 8000 * 1024 }
    ])
    expect(snapshot.runs).toEqual({ active: 2, queued: 1 })
  })

  it('returns the cached snapshot for 5 seconds, then samples again', async () => {
    const src = sources()
    const sampler = new HostMetricsSampler(src)
    const first = await sampler.read('local')
    const same = await sampler.read('local')
    expect(same.sampledAt).toBe(first.sampledAt)
    src.advance(HOST_METRICS_CACHE_MS)
    const next = await sampler.read('local')
    expect(next.sampledAt).toBeGreaterThan(first.sampledAt)
  })

  it('never samples twice within 2 seconds, even after the cache expires', async () => {
    const src = sources()
    const sampler = new HostMetricsSampler(src)
    const first = await sampler.read('local')
    src.advance(HOST_METRICS_CACHE_MS + 1)
    const second = await sampler.read('local')
    expect(second.sampledAt).toBeGreaterThan(first.sampledAt)
    // Read again 1 ms before the minimum interval elapses; the completed sample is still cached.
    src.advance(HOST_METRICS_MIN_INTERVAL_MS - 1)
    const third = await sampler.read('local')
    expect(third.sampledAt).toBe(second.sampledAt)
  })

  it('reports an unreadable process table as null, not as zero processes', async () => {
    const src = sources({ processTable: async () => null })
    const snapshot = await new HostMetricsSampler(src).read('local')
    expect(snapshot.scry.providers).toBeNull()
  })

  it('leaves a failed memory read null instead of reporting 0 used', async () => {
    const src = sources({ pressureText: async () => null, swapText: async () => null })
    const snapshot = await new HostMetricsSampler(src).read('local')
    expect(snapshot.memory.pressure).toBeNull()
    expect(snapshot.memory.swapUsedBytes).toBeNull()
    expect(snapshot.memory.swapTotalBytes).toBeNull()
  })

  it('drops the PID before a remote scope answer', async () => {
    const src = sources()
    const sampler = new HostMetricsSampler(src)
    const local = await sampler.read('local')
    const remote = await sampler.read('remote')
    expect(local.scry.daemon.pid).toBe(900)
    expect(remote.scry.daemon).not.toHaveProperty('pid')
    expect(JSON.stringify(remote)).not.toContain('"pid"')
  })

  it('caps provider rows so one answer stays inside the protocol bound', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `${910 + index}   900   1000  0.1 child${index}`).join('\n')
    const src = sources({
      processTable: async () => `  900  1  12000  0.8 node\n${many}\n`,
      providerRoots: () => Array.from({ length: 40 }, (_, index) => ({ providerId: `p${String(index).padStart(2, '0')}`, pid: 910 + index }))
    })
    const snapshot = await new HostMetricsSampler(src).read('remote')
    expect(snapshot.scry.providers!.length).toBeLessThanOrEqual(13)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(8 * 1024)
  })

  it('keeps a snapshot usable when every platform read fails', async () => {
    const failing = async () => { throw new Error('boom') }
    const src = sources({
      memoryText: failing, pressureText: failing, swapText: failing, processTable: failing,
      statfs: () => { throw new Error('boom') }
    })
    const snapshot: HostMetricsSnapshot = await new HostMetricsSampler(src).read('local')
    expect(snapshot.memory.usedBytes).toBeNull()
    expect(snapshot.disks).toEqual([])
    expect(snapshot.scry.providers).toBeNull()
    expect(snapshot.cpu.cores).toBe(10)
  })
})

describe('production sources', () => {
  const sources = (activeRuns: () => { active: number; queued: number | null }, run: unknown) => createHostMetricsSources({
    platform: 'darwin',
    userDataDir: '/data',
    workspaceRoots: () => ['/work'],
    providerRoots: () => [],
    activeRuns,
    run: run as never,
    readFile: () => null,
    statfs: () => ({ totalBytes: 1, freeBytes: 1 }),
    volumeId: () => 'v',
    now: () => 1
  })

  it('yields to a run that is starting: ps goes under nice while runs are active', async () => {
    const run = vi.fn(async () => '  900  1  12000  0.8 node\n')
    const table = await sources(() => ({ active: 1, queued: 0 }), run).processTable()
    expect(table).toBe('  900  1  12000  0.8 node\n')
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], { timeoutMs: number; maxBytes: number }]
    expect(file).toBe('nice')
    expect(args).toEqual(['-n', '10', 'ps', '-axo', 'pid=,ppid=,rss=,%cpu=,ucomm='])
    expect(options.timeoutMs).toBe(2_000)
    expect(options.maxBytes).toBe(2 * 1024 * 1024)
  })

  it('still reads the queue as active work', async () => {
    const run = vi.fn(async () => '  900  1  12000  0.8 node\n')
    await sources(() => ({ active: 0, queued: 1 }), run).processTable()
    expect((run.mock.calls[0] as unknown as [string])[0]).toBe('nice')
  })

  it('runs the commands in the C locale so %cpu keeps a dot', async () => {
    const run = vi.fn(async () => '  900  1  12000  0.8 node\n')
    await sources(() => ({ active: 0, queued: null }), run).processTable()
    const [, , options] = run.mock.calls[0] as unknown as [string, string[], { env?: Record<string, string> }]
    expect(options.env?.LC_ALL).toBe('C')
  })

  it('skips the extra nice process when nothing is running', async () => {
    const run = vi.fn(async () => '  900  1  12000  0.8 node\n')
    await sources(() => ({ active: 0, queued: 0 }), run).processTable()
    const [file, args] = run.mock.calls[0] as unknown as [string, string[]]
    expect(file).toBe('ps')
    expect(args).toEqual(['-axo', 'pid=,ppid=,rss=,%cpu=,ucomm='])
  })
})
