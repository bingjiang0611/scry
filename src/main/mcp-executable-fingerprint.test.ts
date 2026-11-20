import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { warmShellEnv } from './claude-locate'
import { authorizedMcpExecution, ensureMcpExecutionAuthorized } from './bootstrap/trust'
import { buildMcpExecutionSnapshot, buildMcpExecutionSnapshotAsync } from './mcp-execution-trust'
import {
  mcpExecutableFingerprintStatsForTest,
  resetMcpExecutableFingerprintCacheForTest,
  resolveMcpExecutableFingerprintAsync,
  resolveMcpExecutableFingerprintSync,
  setMcpExecutableFingerprintClockForTest
} from './mcp-executable-fingerprint'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mcp-fp-'))
  tempDirs.push(dir)
  return dir
}

function setupCodexMcpProject(root: string, commandPath: string): void {
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(
    join(root, '.codex', 'config.toml'),
    `[mcp_servers.local]\ncommand = ${JSON.stringify(commandPath)}\nargs = ["serve"]\n`
  )
}

beforeAll(() => warmShellEnv())

afterEach(() => {
  setMcpExecutableFingerprintClockForTest(null)
  resetMcpExecutableFingerprintCacheForTest()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MCP executable fingerprint cache & security invariants (W13)', () => {
  it('shares one hash across gate check and launch re-check and reuses it across warm runs when ctime >= 2s', async () => {
    const root = makeTempDir()
    const bin = join(root, 'server.sh')
    writeFileSync(bin, '#!/bin/sh\necho cached\n')
    chmodSync(bin, 0o755)
    setupCodexMcpProject(root, bin)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)

    const snap1 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snap1).not.toBeNull()
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    const auth1 = authorizedMcpExecution(snap1)
    expect(auth1?.fingerprint).toBe(snap1?.fingerprint)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    const snap2 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    const auth2 = authorizedMcpExecution(snap2)
    expect(auth2?.fingerprint).toBe(snap1?.fingerprint)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().hits).toBeGreaterThanOrEqual(3)
  })

  it('does NOT cache when file ctime is within 2 seconds of hashing', async () => {
    const root = makeTempDir()
    const bin = join(root, 'fresh.sh')
    writeFileSync(bin, '#!/bin/sh\necho fresh\n')
    chmodSync(bin, 0o755)
    setupCodexMcpProject(root, bin)

    const snap1 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snap1).not.toBeNull()
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(0)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    authorizedMcpExecution(snap1)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(0)
  })

  it('re-hashes once a cached entry exceeds the 10-minute maximum reuse TTL', async () => {
    const root = makeTempDir()
    const bin = join(root, 'ttl.sh')
    writeFileSync(bin, '#!/bin/sh\necho ttl\n')
    chmodSync(bin, 0o755)
    setupCodexMcpProject(root, bin)

    const t0 = Date.now() + 5_000
    let fakeNow = t0
    setMcpExecutableFingerprintClockForTest(() => fakeNow)

    const snap1 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // 9m 59s later: still within 10-minute TTL -> cache hit.
    fakeNow = t0 + 9 * 60_000 + 59_000
    authorizedMcpExecution(snap1)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // 10m 00s later: TTL expired -> must re-hash and refresh cache timestamp.
    fakeNow = t0 + 10 * 60_000
    authorizedMcpExecution(snap1)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)

    // 15m 00s later (5m after refresh): reuses refreshed entry.
    fakeNow = t0 + 15 * 60_000
    authorizedMcpExecution(snap1)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })

  it('detects and rejects same-size in-place overwrite with touch -r restoring mtime', async () => {
    const root = makeTempDir()
    const bin = join(root, 'server.sh')
    const refFile = join(root, 'ref-mtime')
    writeFileSync(bin, '#!/bin/sh\necho AAAA\n')
    chmodSync(bin, 0o755)
    execFileSync('touch', ['-r', bin, refFile])
    setupCodexMcpProject(root, bin)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(1)

    writeFileSync(bin, '#!/bin/sh\necho BBBB\n')
    execFileSync('touch', ['-r', refFile, bin])

    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })

  it('detects and rejects same-size in-place overwrite of a symlink target with touch -r restoring mtime', async () => {
    const root = makeTempDir()
    const target = join(root, 'target.sh')
    const link = join(root, 'server-link.sh')
    const refFile = join(root, 'ref-mtime')
    writeFileSync(target, '#!/bin/sh\necho AAAA\n')
    chmodSync(target, 0o755)
    execFileSync('touch', ['-r', target, refFile])
    symlinkSync(target, link)
    setupCodexMcpProject(root, link)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().linkCacheSize).toBe(1)

    // Leave symlink untouched; overwrite its target in place with same byte length and restore target mtime.
    writeFileSync(target, '#!/bin/sh\necho BBBB\n')
    execFileSync('touch', ['-r', refFile, target])

    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })

  it('detects and rejects atomic rename replacement', async () => {
    const root = makeTempDir()
    const bin = join(root, 'server.sh')
    const replacement = join(root, 'server.sh.new')
    writeFileSync(bin, '#!/bin/sh\necho one\n')
    chmodSync(bin, 0o755)
    setupCodexMcpProject(root, bin)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    writeFileSync(replacement, '#!/bin/sh\necho two\n')
    chmodSync(replacement, 0o755)
    renameSync(replacement, bin)

    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })

  it('detects and rejects symlink target retargeting', async () => {
    const root = makeTempDir()
    const targetA = join(root, 'target-a.sh')
    const targetB = join(root, 'target-b.sh')
    const link = join(root, 'server-link.sh')
    writeFileSync(targetA, '#!/bin/sh\necho alpha\n')
    writeFileSync(targetB, '#!/bin/sh\necho alpha\n')
    chmodSync(targetA, 0o755)
    chmodSync(targetB, 0o755)
    symlinkSync(targetA, link)
    setupCodexMcpProject(root, link)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snapshot?.targets[0]?.config.command).toBe(realpathSync(targetA))
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    unlinkSync(link)
    symlinkSync(targetB, link)

    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
  })

  it('invalidates symlink lstat cache entry when symlink itself is replaced even if pointing to the same target', async () => {
    const root = makeTempDir()
    const target = join(root, 'target.sh')
    const link = join(root, 'server-link.sh')
    writeFileSync(target, '#!/bin/sh\necho same-target\n')
    chmodSync(target, 0o755)
    symlinkSync(target, link)
    setupCodexMcpProject(root, link)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().linkCacheSize).toBe(1)

    unlinkSync(link)
    symlinkSync(target, link)
    authorizedMcpExecution(snapshot)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })

  it('detects and rejects permission-bit changes (both still-executable chmod and non-executable chmod)', async () => {
    const root = makeTempDir()
    const bin = join(root, 'server.sh')
    writeFileSync(bin, '#!/bin/sh\necho perm\n')
    chmodSync(bin, 0o700)
    setupCodexMcpProject(root, bin)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    chmodSync(bin, 0o755)
    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)

    const snapshot2 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    chmodSync(bin, 0o644)
    expect(() => authorizedMcpExecution(snapshot2)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
  })

  it('detects and rejects 1-byte mid-hash modification on a 64 MiB file ~5 ms into async hashing', async () => {
    const root = makeTempDir()
    const bigBin = join(root, 'big-64m')
    writeFileSync(bigBin, Buffer.alloc(64 * 1024 * 1024, 0x41))
    chmodSync(bigBin, 0o755)
    setupCodexMcpProject(root, bigBin)

    const tamperTimer = setTimeout(() => {
      const fd = openSync(bigBin, 'r+')
      try {
        writeSync(fd, Buffer.from([0x42]), 0, 1, 0)
      } finally {
        closeSync(fd)
      }
    }, 5)
    try {
      await expect(ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run'))
        .rejects.toThrow('无法稳定校验')
    } finally {
      clearTimeout(tamperTimer)
    }
  })

  it('hashes uncached large executables asynchronously in chunks without starving event-loop timers', async () => {
    const root = makeTempDir()
    const home = makeTempDir()
    const bigBin = join(root, 'big-bin')
    const payload = Buffer.alloc(16 * 1024 * 1024, 0x41)
    writeFileSync(bigBin, payload)
    chmodSync(bigBin, 0o755)
    const expectedDigest = createHash('sha256').update(payload).digest('hex')
    setupCodexMcpProject(root, bigBin)

    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    try {
      const snapshot = await buildMcpExecutionSnapshotAsync({
        providerId: 'codex',
        cwd: root,
        homeDir: home
      })
      expect(snapshot.errors).toEqual([])
      expect(snapshot.targets[0]?.executableDigest).toBe(expectedDigest)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  })

  it('shares a single calculation across concurrent cold async calls, racing sync/async calls, and multi-target sync snapshots', async () => {
    const root = makeTempDir()
    const home = makeTempDir()
    const bigBin = join(root, 'shared-32m')
    const payload = Buffer.alloc(32 * 1024 * 1024, 0x43)
    writeFileSync(bigBin, payload)
    chmodSync(bigBin, 0o755)
    const expectedDigest = createHash('sha256').update(payload).digest('hex')

    // 1. Concurrent cold async calls share one in-flight hash (even when ctime < 2s).
    const [a1, a2] = await Promise.all([
      resolveMcpExecutableFingerprintAsync(bigBin),
      resolveMcpExecutableFingerprintAsync(bigBin)
    ])
    expect(a1.digest).toBe(expectedDigest)
    expect(a2.digest).toBe(expectedDigest)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // 2. Sync call racing an in-flight async call on a cacheable cold file hashes only once.
    resetMcpExecutableFingerprintCacheForTest()
    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    let syncResultDigest: string | undefined
    const asyncPromise = resolveMcpExecutableFingerprintAsync(bigBin)
    const raceTimer = setTimeout(() => {
      syncResultDigest = resolveMcpExecutableFingerprintSync(bigBin).digest
    }, 1)
    try {
      const asyncResult = await asyncPromise
      expect(asyncResult.digest).toBe(expectedDigest)
      if (syncResultDigest !== undefined) {
        expect(syncResultDigest).toBe(expectedDigest)
      }
      expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    } finally {
      clearTimeout(raceTimer)
    }

    // 3. Single sync snapshot with two MCP servers sharing the same <2s executable hashes once,
    //    while a second snapshot still re-hashes (preserving the 2s ctime guard across gate -> launch).
    resetMcpExecutableFingerprintCacheForTest()
    setMcpExecutableFingerprintClockForTest(null)
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(
      join(root, '.codex', 'config.toml'),
      [
        `[mcp_servers.one]\ncommand = ${JSON.stringify(bigBin)}\nargs = ["a"]`,
        `[mcp_servers.two]\ncommand = ${JSON.stringify(bigBin)}\nargs = ["b"]`
      ].join('\n')
    )
    const snapA = buildMcpExecutionSnapshot({ providerId: 'codex', cwd: root, homeDir: home })
    expect(snapA.errors).toEqual([])
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    buildMcpExecutionSnapshot({ providerId: 'codex', cwd: root, homeDir: home })
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
  })
})
