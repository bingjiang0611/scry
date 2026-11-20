import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizedMcpExecution, ensureMcpExecutionAuthorized } from './bootstrap/trust'
import { buildMcpExecutionSnapshotAsync } from './mcp-execution-trust'
import {
  resetMcpExecutableFingerprintCacheForTest,
  setMcpExecutableFingerprintClockForTest,
  mcpExecutableFingerprintStatsForTest
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

    // Advance virtual clock 5 s past file ctime so the file passes the 2 s granularity guard.
    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)

    const snap1 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snap1).not.toBeNull()
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // Launch re-check in the same run must reuse the cached hash (still 1 hash total).
    const auth1 = authorizedMcpExecution(snap1)
    expect(auth1?.fingerprint).toBe(snap1?.fingerprint)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // Subsequent warm run (gate + launch) must perform 0 additional SHA-256 hashes.
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

    // Real clock right after writeFileSync -> ctime age < 2 s -> must NOT cache.
    const snap1 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(snap1).not.toBeNull()
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(0)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)

    // Because it was not cached, launch re-check recomputes SHA-256 rather than trusting a fresh ctime.
    authorizedMcpExecution(snap1)
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(0)
  })

  it('detects and rejects same-size in-place overwrite with touch -r restoring mtime', async () => {
    const root = makeTempDir()
    const bin = join(root, 'server.sh')
    const refFile = join(root, 'ref-mtime')
    writeFileSync(bin, '#!/bin/sh\necho AAAA\n')
    chmodSync(bin, 0o755)
    // Snapshot original mtime onto a reference file.
    execFileSync('touch', ['-r', bin, refFile])
    setupCodexMcpProject(root, bin)

    setMcpExecutableFingerprintClockForTest(() => Date.now() + 5_000)
    const snapshot = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(1)
    expect(mcpExecutableFingerprintStatsForTest().cacheSize).toBe(1)

    // Overwrite in place with exact same byte length, then restore original mtime via touch -r.
    writeFileSync(bin, '#!/bin/sh\necho BBBB\n')
    execFileSync('touch', ['-r', refFile, bin])

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

    // Replace via atomic rename (different inode, even same byte size).
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

    // Retarget symlink to targetB (even with identical bytes!).
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

    // Replace symlink with a new symlink pointing to the exact same target -> lstat stamp changes -> cache miss.
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

    // Change permission bits from 0o700 to 0o755 (still executable, identical content/inode/size).
    chmodSync(bin, 0o755)
    expect(() => authorizedMcpExecution(snapshot)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
    expect(mcpExecutableFingerprintStatsForTest().hashes).toBe(2)

    // Re-authorize at 0o755, then strip execute bits (0o644) -> must also reject.
    const snapshot2 = await ensureMcpExecutionAuthorized({ providerId: 'codex', cwd: root }, 'run')
    chmodSync(bin, 0o644)
    expect(() => authorizedMcpExecution(snapshot2)).toThrow('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
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
})
