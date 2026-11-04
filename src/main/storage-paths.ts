import { join } from 'node:path'

// Where durable storage lives. Electron main resolves the directory once, at
// startup, and injects it; nothing below derives a path from Electron itself. The
// daemon resolves the same directory from its own arguments instead, which is the
// only reason these modules can run without an `app` object.
//
// Unset is a programming error, not a degraded mode: silently falling back to a
// relative path would write a second database somewhere nobody looks.
let userDataDir: string | undefined
let appPath: string | undefined

export function configureStorage(inputs: { userDataDir: string; appPath?: string }): void {
  userDataDir = inputs.userDataDir
  appPath = inputs.appPath
}

// Read-only fixtures ship beside the app; only Electron main knows where that is.
export function storageAppPath(): string {
  if (!appPath) throw new Error('storage_not_configured')
  return appPath
}

export function storageUserDataDir(): string {
  if (!userDataDir) throw new Error('storage_not_configured')
  return userDataDir
}

export function storageDbFilePath(): string {
  return join(storageUserDataDir(), 'scry.db')
}

export function storageTurnOutboxDir(): string {
  return join(storageUserDataDir(), 'db-turn-outbox')
}
