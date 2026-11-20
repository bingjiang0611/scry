import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats
} from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'

export interface McpExecutableFingerprint {
  canonical: string
  digest: string
  identity: string
}

export type McpExecutableVerification =
  | { ok: true; fingerprint: McpExecutableFingerprint }
  | { ok: false; identity: string; fatalError?: string; executableError?: string }

interface FileStamp {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  mode: bigint
}

interface TargetCacheEntry {
  stamp: FileStamp
  digest: string
  cachedAtNs: bigint
}

interface LinkCacheEntry {
  stamp: FileStamp
  targetCanonical: string
  cachedAtNs: bigint
}

interface TargetHashResult {
  stamp: FileStamp
  digest: string
  hashStartedNs: bigint
}

export type McpExecutableRunMemo = Map<string, TargetHashResult>

const MAX_CACHE_ENTRIES = 256
const SYNC_CHUNK_BYTES = 64 * 1024
const ASYNC_CHUNK_BYTES = 256 * 1024
const CTIME_FRESHNESS_GUARD_NS = 2_000_000_000n
const MAX_CACHE_AGE_NS = 600_000_000_000n // 10 minutes

const targetCache = new Map<string, TargetCacheEntry>()
const linkCache = new Map<string, LinkCacheEntry>()
const inFlightTargetAsync = new Map<string, Promise<TargetHashResult>>()

let clockMs: (() => number) | null = null
let hashCount = 0
let hitCount = 0

function nowNs(): bigint {
  return BigInt(Math.trunc(clockMs ? clockMs() : Date.now())) * 1_000_000n
}

function toStamp(fileStat: BigIntStats): FileStamp {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeNs: fileStat.mtimeNs,
    ctimeNs: fileStat.ctimeNs,
    mode: fileStat.mode
  }
}

function stampsEqual(a: FileStamp, b: FileStamp): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode
  )
}

function targetStampKey(canonical: string, stamp: FileStamp): string {
  return `${canonical}:${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mtimeNs}:${stamp.ctimeNs}:${stamp.mode}`
}

function isOutsideCtimeGuard(hashStartedNs: bigint, ctimeNs: bigint): boolean {
  return hashStartedNs >= ctimeNs && hashStartedNs - ctimeNs >= CTIME_FRESHNESS_GUARD_NS
}

function isWithinMaxCacheAge(currentNs: bigint, cachedAtNs: bigint): boolean {
  return currentNs >= cachedAtNs && currentNs - cachedAtNs < MAX_CACHE_AGE_NS
}

function touchLru<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function formatIdentity(canonical: string, stamp: FileStamp, digest: string): string {
  return `${canonical}:${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mode}:sha256:${digest}`
}

function lookupFreshTargetEntry(canonical: string, targetStamp: FileStamp, currentNs: bigint): TargetCacheEntry | null {
  const cachedTarget = targetCache.get(canonical)
  if (!cachedTarget) return null
  if (!stampsEqual(cachedTarget.stamp, targetStamp)) return null
  if (!isWithinMaxCacheAge(currentNs, cachedTarget.cachedAtNs)) {
    targetCache.delete(canonical)
    return null
  }
  return cachedTarget
}

function lookupCache(
  absolute: string,
  canonical: string,
  linkStat: BigIntStats,
  targetStamp: FileStamp
): McpExecutableFingerprint | null {
  const currentNs = nowNs()
  const cachedTarget = lookupFreshTargetEntry(canonical, targetStamp, currentNs)
  if (!cachedTarget) return null
  if (linkStat.isSymbolicLink()) {
    const cachedLink = linkCache.get(absolute)
    const linkStamp = toStamp(linkStat)
    if (!cachedLink || cachedLink.targetCanonical !== canonical || !stampsEqual(cachedLink.stamp, linkStamp)) {
      return null
    }
    if (!isWithinMaxCacheAge(currentNs, cachedLink.cachedAtNs)) {
      linkCache.delete(absolute)
      return null
    }
    touchLru(linkCache, absolute, cachedLink)
  }
  touchLru(targetCache, canonical, cachedTarget)
  hitCount += 1
  return {
    canonical,
    digest: cachedTarget.digest,
    identity: formatIdentity(canonical, targetStamp, cachedTarget.digest)
  }
}

function storeTargetCache(canonical: string, hashStartedNs: bigint, targetAfter: FileStamp, digest: string): void {
  if (isOutsideCtimeGuard(hashStartedNs, targetAfter.ctimeNs)) {
    touchLru(targetCache, canonical, { stamp: targetAfter, digest, cachedAtNs: hashStartedNs })
  } else {
    targetCache.delete(canonical)
  }
}

function storeLinkCache(absolute: string, canonical: string, hashStartedNs: bigint, linkAfter: BigIntStats): void {
  if (linkAfter.isSymbolicLink()) {
    const linkStamp = toStamp(linkAfter)
    if (isOutsideCtimeGuard(hashStartedNs, linkStamp.ctimeNs)) {
      touchLru(linkCache, absolute, { stamp: linkStamp, targetCanonical: canonical, cachedAtNs: hashStartedNs })
    } else {
      linkCache.delete(absolute)
    }
  } else {
    linkCache.delete(absolute)
  }
}

function hashTargetSync(canonical: string, expectedBeforeStamp: FileStamp): TargetHashResult {
  const hashStartedNs = nowNs()
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile()) throw new Error('not a regular file')
    const beforeStamp = toStamp(before)
    if (!stampsEqual(beforeStamp, expectedBeforeStamp)) throw new Error('executable changed while hashing')
    const expectedSize = Number(before.size)
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new Error('executable size unsupported')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(SYNC_CHUNK_BYTES)
    let position = 0
    while (position < expectedSize) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, expectedSize - position), position)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = fstatSync(fd, { bigint: true })
    const afterStamp = toStamp(after)
    const pathAfter = statSync(canonical, { bigint: true })
    if (
      BigInt(position) !== before.size ||
      !stampsEqual(beforeStamp, afterStamp) ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    ) {
      throw new Error('executable changed while hashing')
    }
    const hexDigest = digest.digest('hex')
    hashCount += 1
    storeTargetCache(canonical, hashStartedNs, afterStamp, hexDigest)
    return { stamp: afterStamp, digest: hexDigest, hashStartedNs }
  } finally {
    closeSync(fd)
  }
}

async function hashTargetAsync(canonical: string, expectedBeforeStamp: FileStamp): Promise<TargetHashResult> {
  const hashStartedNs = nowNs()
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('not a regular file')
    const beforeStamp = toStamp(before)
    if (!stampsEqual(beforeStamp, expectedBeforeStamp)) throw new Error('executable changed while hashing')
    const expectedSize = Number(before.size)
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new Error('executable size unsupported')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(ASYNC_CHUNK_BYTES)
    let position = 0
    let reusedDigest: string | null = null
    while (position < expectedSize) {
      // If a concurrent sync call already hashed this exact stamp, reuse its digest and still run post-checks.
      const synced = lookupFreshTargetEntry(canonical, beforeStamp, nowNs())
      if (synced) {
        reusedDigest = synced.digest
        break
      }
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position
      )
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const afterStamp = toStamp(after)
    const pathAfter = await stat(canonical, { bigint: true })
    if (
      (reusedDigest === null && BigInt(position) !== before.size) ||
      !stampsEqual(beforeStamp, afterStamp) ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    ) {
      throw new Error('executable changed while hashing')
    }
    if (reusedDigest !== null) {
      hitCount += 1
      return { stamp: afterStamp, digest: reusedDigest, hashStartedNs }
    }
    const hexDigest = digest.digest('hex')
    hashCount += 1
    storeTargetCache(canonical, hashStartedNs, afterStamp, hexDigest)
    return { stamp: afterStamp, digest: hexDigest, hashStartedNs }
  } finally {
    await handle.close()
  }
}

export function resolveMcpExecutableFingerprintSync(
  absolute: string,
  runMemo?: McpExecutableRunMemo
): McpExecutableFingerprint {
  const linkBefore = lstatSync(absolute, { bigint: true })
  const canonical = realpathSync(absolute)
  if (process.platform !== 'win32') accessSync(canonical, constants.X_OK)
  const targetBefore = statSync(canonical, { bigint: true })
  if (!targetBefore.isFile()) throw new Error('not a regular file')
  const targetBeforeStamp = toStamp(targetBefore)

  const cached = lookupCache(absolute, canonical, linkBefore, targetBeforeStamp)
  if (cached) return cached

  const key = targetStampKey(canonical, targetBeforeStamp)
  const memoHit = runMemo?.get(key)
  if (memoHit) {
    storeLinkCache(absolute, canonical, memoHit.hashStartedNs, linkBefore)
    hitCount += 1
    return {
      canonical,
      digest: memoHit.digest,
      identity: formatIdentity(canonical, memoHit.stamp, memoHit.digest)
    }
  }

  targetCache.delete(canonical)
  linkCache.delete(absolute)

  const result = hashTargetSync(canonical, targetBeforeStamp)
  const linkAfter = lstatSync(absolute, { bigint: true })
  const canonicalAfter = realpathSync(absolute)
  if (canonicalAfter !== canonical || !stampsEqual(toStamp(linkBefore), toStamp(linkAfter))) {
    targetCache.delete(canonical)
    throw new Error('executable changed while hashing')
  }
  storeLinkCache(absolute, canonical, result.hashStartedNs, linkAfter)
  runMemo?.set(key, result)
  return {
    canonical,
    digest: result.digest,
    identity: formatIdentity(canonical, result.stamp, result.digest)
  }
}

export async function resolveMcpExecutableFingerprintAsync(
  absolute: string,
  runMemo?: McpExecutableRunMemo
): Promise<McpExecutableFingerprint> {
  const linkBefore = await lstat(absolute, { bigint: true })
  const canonical = await realpath(absolute)
  if (process.platform !== 'win32') await access(canonical, constants.X_OK)
  const targetBefore = await stat(canonical, { bigint: true })
  if (!targetBefore.isFile()) throw new Error('not a regular file')
  const targetBeforeStamp = toStamp(targetBefore)

  const cached = lookupCache(absolute, canonical, linkBefore, targetBeforeStamp)
  if (cached) return cached

  const key = targetStampKey(canonical, targetBeforeStamp)
  const memoHit = runMemo?.get(key)
  if (memoHit) {
    storeLinkCache(absolute, canonical, memoHit.hashStartedNs, linkBefore)
    hitCount += 1
    return {
      canonical,
      digest: memoHit.digest,
      identity: formatIdentity(canonical, memoHit.stamp, memoHit.digest)
    }
  }

  let pending = inFlightTargetAsync.get(key)
  if (!pending) {
    targetCache.delete(canonical)
    linkCache.delete(absolute)
    pending = hashTargetAsync(canonical, targetBeforeStamp).finally(() => {
      if (inFlightTargetAsync.get(key) === pending) inFlightTargetAsync.delete(key)
    })
    inFlightTargetAsync.set(key, pending)
  }
  const result = await pending
  const linkAfter = await lstat(absolute, { bigint: true })
  const canonicalAfter = await realpath(absolute)
  if (canonicalAfter !== canonical || !stampsEqual(toStamp(linkBefore), toStamp(linkAfter))) {
    linkCache.delete(absolute)
    throw new Error('executable changed while hashing')
  }
  storeLinkCache(absolute, canonical, result.hashStartedNs, linkAfter)
  runMemo?.set(key, result)
  return {
    canonical,
    digest: result.digest,
    identity: formatIdentity(canonical, result.stamp, result.digest)
  }
}

function classifyFingerprintError(serverName: string, absolute: string, error: unknown): McpExecutableVerification {
  const message = error instanceof Error ? error.message : String(error)
  if (/changed while hashing|changed during|EIO|EBUSY/i.test(message)) {
    return {
      ok: false,
      identity: `blocked:${absolute}`,
      fatalError: `MCP server ${serverName} 的 executable 无法稳定校验：${absolute}`
    }
  }
  return {
    ok: false,
    identity: `unverified:${absolute}`,
    executableError: `executable 不存在或不是可执行文件：${absolute}`
  }
}

export function verifyMcpExecutableSync(
  serverName: string,
  absolute: string,
  runMemo?: McpExecutableRunMemo
): McpExecutableVerification {
  try {
    return { ok: true, fingerprint: resolveMcpExecutableFingerprintSync(absolute, runMemo) }
  } catch (error) {
    return classifyFingerprintError(serverName, absolute, error)
  }
}

export async function verifyMcpExecutableAsync(
  serverName: string,
  absolute: string,
  runMemo?: McpExecutableRunMemo
): Promise<McpExecutableVerification> {
  try {
    return { ok: true, fingerprint: await resolveMcpExecutableFingerprintAsync(absolute, runMemo) }
  } catch (error) {
    return classifyFingerprintError(serverName, absolute, error)
  }
}

export function resetMcpExecutableFingerprintCacheForTest(): void {
  targetCache.clear()
  linkCache.clear()
  inFlightTargetAsync.clear()
  hashCount = 0
  hitCount = 0
}

export function setMcpExecutableFingerprintClockForTest(fn: (() => number) | null): void {
  clockMs = fn
}

export function mcpExecutableFingerprintStatsForTest(): {
  hashes: number
  hits: number
  cacheSize: number
  linkCacheSize: number
} {
  return {
    hashes: hashCount,
    hits: hitCount,
    cacheSize: targetCache.size,
    linkCacheSize: linkCache.size
  }
}
