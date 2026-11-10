// Redacts identifiers from the committed copy of local verification evidence.
// Timings, error text, rule outcomes and capability lists are kept; what goes
// is anything that identifies the person, their devices or their relay room:
//   - UUIDs (relay host/room ids, session and run ids) -> stable salted aliases
//   - iPhone UDIDs, signing identities (Apple ID, team id, certificate hash)
//   - account names in absolute home paths, e-mail addresses
//   - public IPv4 addresses (private LAN / CGNAT ranges stay: they are the
//     evidence for route selection and identify no one)
// Aliases are stable within one invocation (so the same room reads the same
// everywhere in a run) and unlinkable across invocations (random salt).
// Idempotent: an alias is never re-matched. Raw logs in raw/ and *.log stay
// local and gitignored; only committed files are rewritten.
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEEP_EMAILS = /noreply/i
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const UDID = /\b[0-9A-F]{8}-[0-9A-F]{16}\b/g
const HOME = /(\/Users|\/home)\/(?!<user>)[^/\s"'\\]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SIGNING = /(Apple (?:Development|Distribution)|iPhone (?:Developer|Distribution)|Developer ID Application): [^"\n)]*\(([A-Z0-9]{10})\)/g
// A signing certificate's SHA-1 appears as identityHash=… (electron-builder)
// and as `--sign <hash>` (codesign, swift-stdlib-tool in xcodebuild logs).
const CERT_HASH = /(identityHash=|--sign\s+)[0-9A-F]{40}\b/g
// Not part of a longer dotted/word token (keeps versions like swiftlang-6.3.3.1.3).
const IPV4 = /(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g

function isKeptAddress(a, b) {
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) || a === 0
}

export function createRedactor(salt = randomBytes(16)) {
  const alias = (value) => createHash('sha256').update(salt).update(value.toLowerCase()).digest('hex').slice(0, 8)
  return (text) => text
    .replace(SIGNING, (_, kind) => `${kind}: <signing-identity> (<team>)`)
    .replace(CERT_HASH, '$1<redacted>')
    .replace(UDID, '<device-udid>')
    .replace(UUID, (id) => `<id:${alias(id)}>`)
    .replace(HOME, '$1/<user>')
    .replace(EMAIL, (address) => KEEP_EMAILS.test(address) ? address : '<email>')
    .replace(IPV4, (ip, a, b, c, d) => {
      const octets = [a, b, c, d].map(Number)
      if (octets.some((n) => n > 255)) return ip
      return isKeptAddress(octets[0], octets[1]) ? ip : '<public-ip>'
    })
}

const TEXT = /\.(md|json|jsonl|txt)$/

// Rewrites committed text files under `dir` in place; skips raw/ and *.log.
export function redactResults(dir, redact = createRedactor()) {
  let changed = 0
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) { if (name !== 'raw') walk(path); continue }
      if (!TEXT.test(name)) continue
      const before = readFileSync(path, 'utf8')
      const after = redact(before)
      if (after !== before) { writeFileSync(path, after); changed += 1 }
    }
  }
  walk(dir)
  return changed
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const redact = createRedactor()
  let total = 0
  for (const dir of process.argv.slice(2)) total += redactResults(dir, redact)
  console.log(`redacted ${total} file(s)`)
}
