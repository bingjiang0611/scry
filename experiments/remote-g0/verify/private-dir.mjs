// Makes sure the verification results directories are ones only this account
// can change before local-verify.sh writes step logs into them or installs a
// phone build out of them. SCRY_VERIFY_RESULTS may point anywhere, so checking
// the leaf alone is not enough: an account that can write any ancestor could
// rename it away and put its own tree (or a symlink) in its place.
//
// Every component is walked from the filesystem root with lstat:
//   - an ancestor must be a directory owned by this account or by root, and
//     must not be group/other-writable unless it is root's and sticky (/tmp),
//     where nobody else can replace an entry this account owns;
//   - a symlink is followed only when root owns it (macOS /tmp, /var), and its
//     target is walked the same way; any other symlink is refused;
//   - the directories asked for must be owned by this account itself and not
//     be group/other-writable. Missing ones are created one level at a time
//     with mode 700 after their parent passed.
// Once that holds, no other account (root aside) can change the tree, so one
// check before writing is enough. Same-account attackers are outside the trust
// model, as in CLAUDE.md.
import { chmodSync, lstatSync, mkdirSync, readlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const GROUP_OTHER_WRITE = 0o022
const STICKY = 0o1000
const MAX_LINKS = 8

export class UnsafePathError extends Error {}

function checkAncestor(path, stat, uid) {
  if (!stat.isDirectory()) throw new UnsafePathError(`${path} is not a directory`)
  if (stat.uid !== uid && stat.uid !== 0) throw new UnsafePathError(`${path} is owned by uid ${stat.uid}`)
  if ((stat.mode & GROUP_OTHER_WRITE) && !(stat.uid === 0 && (stat.mode & STICKY))) {
    throw new UnsafePathError(`${path} is writable by other accounts`)
  }
}

function checkOwn(path, stat, uid) {
  if (stat.isSymbolicLink()) throw new UnsafePathError(`${path} is a symlink`)
  if (!stat.isDirectory()) throw new UnsafePathError(`${path} is not a directory`)
  if (stat.uid !== uid) throw new UnsafePathError(`${path} is owned by uid ${stat.uid}, not ${uid}`)
  if (stat.mode & GROUP_OTHER_WRITE) throw new UnsafePathError(`${path} is writable by other accounts`)
}

// Walks an existing absolute path; returns its resolved form.
function walk(path, uid, links = 0) {
  if (links > MAX_LINKS) throw new UnsafePathError(`${path}: too many symlinks`)
  let current = sep
  checkAncestor(current, lstatSync(current), uid)
  for (const name of path.split(sep).filter(Boolean)) {
    const next = join(current, name)
    const stat = lstatSync(next)
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0) throw new UnsafePathError(`${next} is a symlink owned by uid ${stat.uid}`)
      current = walk(resolve(current, readlinkSync(next)), uid, links + 1)
      continue
    }
    checkAncestor(next, stat, uid)
    current = next
  }
  return current
}

function exists(path) {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Ensures `dir` exists, is this account's own and is reached only through
// trusted ancestors. `mode` (e.g. 0o700) is applied after the checks pass.
export function ensurePrivateDir(dir, { uid = process.getuid(), mode } = {}) {
  const target = resolve(dir)
  const parts = target.split(sep).filter(Boolean)
  let existing = parts.length
  while (existing > 0 && !exists(sep + parts.slice(0, existing).join(sep))) existing -= 1
  // The directory asked for is never reached through a link, even root's.
  if (existing === parts.length && lstatSync(target).isSymbolicLink()) {
    throw new UnsafePathError(`${target} is a symlink`)
  }
  let current = walk(sep + parts.slice(0, existing).join(sep), uid)
  for (const name of parts.slice(existing)) {
    current = join(current, name)
    try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    checkOwn(current, lstatSync(current), uid)
  }
  checkOwn(current, lstatSync(current), uid)
  if (mode !== undefined) chmodSync(current, mode)
  return current
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  let mode
  if (args[0] === '--mode') { mode = parseInt(args[1], 8); args.splice(0, 2) }
  try {
    for (const dir of args) ensurePrivateDir(dir, { mode })
  } catch (error) {
    console.error(`refusing results directory: ${error.message}`)
    process.exit(1)
  }
}
