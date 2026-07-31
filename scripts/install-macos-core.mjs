import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

const JOURNAL_NAME = '.scry-install-journal.json'
const LOCK_NAME = '.scry-install.lock'
const LOCK_TOMBSTONE_PREFIX = '.scry-install.lock.stale-'
const APP_NAME = 'Scry.app'
const BACKUP_NAME = '.Scry.app.backup'
const STAGING_PREFIX = '.Scry.app.staging-'

function readInstallLock(installRoot) {
  const file = join(installRoot, LOCK_NAME)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  const valid =
    value?.version === 1 &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === 'number' &&
    typeof value.token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)
  if (!valid) throw new Error(`安装锁损坏，拒绝覆盖：${file}`)
  return value
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function sameFile(left, right) {
  try {
    const leftStat = statSync(left)
    const rightStat = statSync(right)
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function recoverStaleInstallLock(installRoot) {
  const lockPath = join(installRoot, LOCK_NAME)
  const owner = readInstallLock(installRoot)
  if (processIsAlive(owner.pid)) {
    throw new Error(`另一个 Scry 安装正在进行（pid ${owner.pid}）`)
  }

  // A deterministic hard-link tombstone elects exactly one stale-lock remover.
  // It is intentionally retained: a delayed contender can never mistake a new
  // owner's lock for the dead lock it inspected earlier.
  const tombstone = join(installRoot, `${LOCK_TOMBSTONE_PREFIX}${owner.token}`)
  try {
    linkSync(lockPath, tombstone)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error
  }
  if (!sameFile(lockPath, tombstone)) return false
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return false
  }
  syncDirectory(installRoot)
  return true
}

function acquireInstallLock(installRoot) {
  mkdirSync(installRoot, { recursive: true })
  const path = join(installRoot, LOCK_NAME)
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const owner = { version: 1, pid: process.pid, startedAt: Date.now(), token: randomUUID() }
    let fd
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      recoverStaleInstallLock(installRoot)
      continue
    }
    try {
      writeFileSync(fd, `${JSON.stringify(owner)}\n`)
      fsyncSync(fd)
    } catch (error) {
      try { unlinkSync(path) } catch {}
      throw error
    } finally {
      closeSync(fd)
    }
    syncDirectory(installRoot)
    return { path, token: owner.token }
  }
  throw new Error('无法取得 Scry 安装锁')
}

function releaseInstallLock(installRoot, lock) {
  const owner = readInstallLock(installRoot)
  if (owner.token !== lock.token) throw new Error('安装锁 owner 已变化，拒绝删除')
  unlinkSync(lock.path)
  syncDirectory(installRoot)
}

function syncDirectory(path) {
  try {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch {
    // APFS supports directory fsync, but keep the installer usable on filesystems that reject it.
  }
}

function writeJournal(installRoot, journal) {
  const file = join(installRoot, JOURNAL_NAME)
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(journal)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  syncDirectory(installRoot)
}

function clearJournal(installRoot) {
  const file = join(installRoot, JOURNAL_NAME)
  if (existsSync(file)) unlinkSync(file)
  syncDirectory(installRoot)
}

function readJournal(installRoot) {
  const file = join(installRoot, JOURNAL_NAME)
  if (!existsSync(file)) return null
  const value = JSON.parse(readFileSync(file, 'utf8'))
  const valid =
    value?.version === 1 &&
    ['prepared', 'backup_created', 'installed'].includes(value.phase) &&
    typeof value.hadTarget === 'boolean' &&
    typeof value.stagingName === 'string' &&
    value.stagingName.startsWith(STAGING_PREFIX) &&
    basename(value.stagingName) === value.stagingName
  if (!valid) throw new Error(`安装 journal 损坏：${file}`)
  return value
}

function pathsFor(installRoot, stagingName) {
  const root = resolve(installRoot)
  const target = resolve(root, APP_NAME)
  const backup = resolve(root, BACKUP_NAME)
  const staging = resolve(root, stagingName)
  if (dirname(target) !== root || dirname(backup) !== root || dirname(staging) !== root) {
    throw new Error('安装路径越界')
  }
  return { root, target, backup, staging }
}

function recoverInterruptedInstallLocked({ installRoot, registerBundle = () => {}, warn = () => {} }) {
  const journal = readJournal(installRoot)
  if (!journal) return { recovered: false }
  const { target, backup, staging } = pathsFor(installRoot, journal.stagingName)

  if (journal.phase === 'prepared') {
    // Crash may have happened immediately after target -> backup but before the next journal fsync.
    if (!existsSync(target) && journal.hadTarget && existsSync(backup)) renameSync(backup, target)
  } else if (journal.hadTarget) {
    if (existsSync(backup)) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      renameSync(backup, target)
    } else if (!existsSync(target)) {
      throw new Error('安装恢复失败：target 与 backup 都不存在')
    }
  } else if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }

  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  clearJournal(installRoot)
  if (journal.hadTarget && existsSync(target)) {
    try { registerBundle(target) } catch (error) { warn(`旧版本已恢复，但 LaunchServices 重新注册失败：${error.message}`) }
  }
  return { recovered: true, target }
}

export function recoverInterruptedInstall(args) {
  const lock = acquireInstallLock(args.installRoot)
  try {
    return recoverInterruptedInstallLocked(args)
  } finally {
    releaseInstallLock(args.installRoot, lock)
  }
}

export function installBundle({
  source,
  installRoot,
  copyBundle,
  validateBundle,
  registerBundle,
  indexBundle = () => {},
  warn = () => {}
}) {
  const lock = acquireInstallLock(installRoot)
  try {
    recoverInterruptedInstallLocked({ installRoot, registerBundle, warn })

    const stagingName = `${STAGING_PREFIX}${process.pid}-${randomUUID()}`
    const { target, backup, staging } = pathsFor(installRoot, stagingName)
    const hadTarget = existsSync(target)
    const journal = { version: 1, phase: 'prepared', hadTarget, stagingName }
    writeJournal(installRoot, journal)
    try {
      copyBundle(source, staging)
      validateBundle(staging)
    } catch (error) {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
      clearJournal(installRoot)
      throw error
    }

    try {
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      if (hadTarget) renameSync(target, backup)
      journal.phase = 'backup_created'
      writeJournal(installRoot, journal)
      renameSync(staging, target)
      journal.phase = 'installed'
      writeJournal(installRoot, journal)
      validateBundle(target)
      registerBundle(target)
      clearJournal(installRoot)
    } catch (error) {
      let rollbackError
      try {
        recoverInterruptedInstallLocked({ installRoot, registerBundle, warn })
      } catch (caught) {
        rollbackError = caught
      }
      if (rollbackError) {
        throw new AggregateError([error, rollbackError], '安装失败，且自动回滚未完成')
      }
      throw error
    }

    try { indexBundle(target) } catch (error) { warn(`安装成功，但 Spotlight 索引失败：${error.message}`) }
    return { target, backup: hadTarget ? backup : null }
  } finally {
    releaseInstallLock(installRoot, lock)
  }
}

export const installJournalName = JOURNAL_NAME
export const installLockName = LOCK_NAME
