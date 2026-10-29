export const MAX_BYTES = 8 * 1024 * 1024
export const DB_NAME = '.checkpoint-prototype.sqlite'
export type Operation =
  | { op: 'begin' | 'commit' | 'rollback' | 'stats' | 'close' | 'release' }
  | { op: 'get'; name: string }
  | { op: 'put'; name: string; text: string }
  | { op: 'list'; after: string }
  | { op: 'fault'; fault: 'before_commit' | 'lost_commit_reply' | 'hold_commit' }
export type Request = Operation & { id: number }
export type Stats = {
  transactions: number; mutations: number; gets: number; lists: number
  bodyBytes: number; dbBytes: number; walBytes: number
  journalMode: string; synchronous: number; fullfsync: number; checkpointFullfsync: number; sqliteVersion: string
}
export type Response = { id: number } & (
  | { ok: true; value: unknown }
  | { ok: false; error: string; unknown: boolean }
)
export function metadataName(name: string): boolean {
  return !['preferences.json', 'settings.json'].includes(name) &&
    /^(?:[A-Za-z0-9_-]{1,96}\.json|[A-Za-z0-9_-]{1,96}\.planning\.json|[A-Za-z0-9_-]{1,96}\.[A-Za-z0-9_-]{1,96}\.frame\.json)$/.test(name)
}
export class StorageError extends Error {
  constructor(message: string, readonly unknown: boolean) { super(message) }
}
