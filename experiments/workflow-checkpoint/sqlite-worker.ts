import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DB_NAME, MAX_BYTES, metadataName, type Request, type Response, type Stats } from './protocol'

const port = parentPort!
const data = workerData as { directory: string; create: boolean }
const path = join(data.directory, DB_NAME)
if (data.create) closeSync(openSync(path, 'wx', 0o600))
const db = new DatabaseSync(path, { timeout: 0 })
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON')
if (data.create) db.exec('CREATE TABLE metadata (name TEXT PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL) WITHOUT ROWID; PRAGMA user_version=1')
const pragma = (name: string) => Object.values(db.prepare('PRAGMA ' + name).get()!)[0]
if (pragma('user_version') !== 1 || pragma('journal_mode') !== 'wal' || pragma('synchronous') !== 2 || pragma('fullfsync') !== 1 || pragma('checkpoint_fullfsync') !== 1) throw new Error('checkpoint durability configuration mismatch')
const get = db.prepare('SELECT body, hash FROM metadata WHERE name=?')
const put = db.prepare('INSERT INTO metadata VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body, hash=excluded.hash')
const list = db.prepare('SELECT name FROM metadata WHERE name>? ORDER BY name LIMIT 64')
const counters = { transactions: 0, mutations: 0, gets: 0, lists: 0, bodyBytes: 0 }
let active = false, closed = false, fault: 'before_commit' | 'lost_commit_reply' | 'hold_commit' | undefined
let release: (() => void) | undefined
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function bytes(path: string) {
  try { return statSync(path).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}
function stats(): Stats {
  return { ...counters, dbBytes: bytes(path), walBytes: bytes(path + '-wal'), journalMode: String(pragma('journal_mode')),
    synchronous: Number(pragma('synchronous')), fullfsync: Number(pragma('fullfsync')), checkpointFullfsync: Number(pragma('checkpoint_fullfsync')),
    sqliteVersion: String(db.prepare('SELECT sqlite_version() version').get()!.version) }
}
port.postMessage({ ready: stats() })
async function handle(request: Request): Promise<void> {
  let unknown = false
  try {
    if (closed) throw new Error('checkpoint worker closed')
    let value: unknown
    switch (request.op) {
      case 'begin':
        if (active) throw new Error('nested SQLite transaction')
        db.exec('BEGIN IMMEDIATE'); active = true; break
      case 'get': {
        if (!metadataName(request.name)) throw new Error('invalid metadata name')
        counters.gets++
        const row = get.get(request.name)
        if (row) {
          if (typeof row.body !== 'string' || typeof row.hash !== 'string' || Buffer.byteLength(row.body) > MAX_BYTES || digest(row.body) !== row.hash) throw new Error('checkpoint metadata hash mismatch')
          value = row.body
        }
        break
      }
      case 'put':
        if (!active || !metadataName(request.name) || typeof request.text !== 'string' || Buffer.byteLength(request.text) > MAX_BYTES) throw new Error('invalid checkpoint mutation')
        put.run(request.name, request.text, digest(request.text)); counters.mutations++; counters.bodyBytes += Buffer.byteLength(request.text); break
      case 'list':
        counters.lists++; value = list.all(request.after).map(row => String(row.name)); break
      case 'commit': {
        if (!active) throw new Error('commit without transaction')
        const current = fault; fault = undefined
        if (current === 'before_commit') throw new Error('injected before COMMIT')
        if (current === 'hold_commit') {
          const gate = new Promise<void>(resolve => { release = resolve })
          port.postMessage({ held: true })
          await gate
        }
        unknown = true
        db.exec('COMMIT'); active = false; counters.transactions++
        // Exit the actual Worker after COMMIT and before any response. The
        // client must infer unknown from transport loss, not a fake error reply.
        if (current === 'lost_commit_reply') process.exit(74)
        unknown = false
        break
      }
      case 'rollback':
        if (active) db.exec('ROLLBACK')
        active = false; break
      case 'fault': fault = request.fault; break
      case 'release':
        if (!release) throw new Error('no held COMMIT')
        release(); release = undefined; break
      case 'stats': value = stats(); break
      case 'close':
        if (active) db.exec('ROLLBACK')
        active = false; value = stats(); db.close(); closed = true; break
    }
    port.postMessage({ id: request.id, ok: true, value } satisfies Response)
    if (closed) port.close()
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: String(error), unknown } satisfies Response)
  }
}
// The client permits one request at a time. release is the sole out-of-band
// test control and cannot read/write SQL while the real commit is held.
port.on('message', (request: Request) => {
  if (release && request.op !== 'release') {
    port.postMessage({ id: request.id, ok: false, error: 'COMMIT is held', unknown: false } satisfies Response)
    return
  }
  void handle(request)
})
