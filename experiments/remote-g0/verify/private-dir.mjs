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
import { dirname, isAbsolute, join, sep } from 'node:path'
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

// Walks an existing path, given as absolute components, the way the kernel
// resolves it: a link is followed before any later `..` applies, so `..` is
// taken from the directory actually reached (its real parent), never by
// trimming the text. Returns the real path reached.
function walk(parts, uid, links = 0) {
  if (links > MAX_LINKS) throw new UnsafePathError(`${parts.join(sep)}: too many symlinks`)
  let current = sep
  checkAncestor(current, lstatSync(current), uid)
  for (const name of parts) {
    if (name === '.') continue
    if (name === '..') { current = dirname(current); continue }
    const next = join(current, name)
    const stat = lstatSync(next)
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0) throw new UnsafePathError(`${next} is a symlink owned by uid ${stat.uid}`)
      const target = readlinkSync(next)
      const base = isAbsolute(target) ? [] : components(current)
      current = walk([...base, ...components(target)], uid, links + 1)
      continue
    }
    checkAncestor(next, stat, uid)
    current = next
  }
  return current
}

const components = (path) => path.split(sep).filter(Boolean)

function exists(path) {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Ensures `dir` exists, is this account's own and is reached only through
// trusted ancestors. `mode` (e.g. 0o700) is applied after the checks pass.
export function ensurePrivateDir(dir, { uid = process.getuid(), mode } = {}) {
  // No lexical normalization (path.resolve would turn `link/../run` into
  // `run` while the kernel follows `link` first). The script keeps using the
  // text it passed, so refuse `.`/`..` outright: then the checked walk below
  // and every later open resolve the same components the same way.
  const target = isAbsolute(dir) ? dir : `${process.cwd()}${sep}${dir}`
  const parts = components(target)
  if (parts.some((name) => name === '.' || name === '..')) {
    throw new UnsafePathError(`${dir} contains . or .. components`)
  }
  let existing = parts.length
  while (existing > 0 && !exists(sep + parts.slice(0, existing).join(sep))) existing -= 1
  // The directory asked for is never reached through a link, even root's.
  if (existing === parts.length && lstatSync(target).isSymbolicLink()) {
    throw new UnsafePathError(`${target} is a symlink`)
  }
  let current = walk(parts.slice(0, existing), uid)
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
