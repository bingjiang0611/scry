import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { locatePiNativeSession } from '../main/pi-native-history'
import { validateHeader, type NativeEntry } from '../main/pi-native-parse'
import { transcriptPath, trustedOwnedFile } from '../main/transcript-archive-paths'
import { resolveNativeTranscriptPath } from '../main/transcript-archive-mirror'
import type { TranscriptSource } from '../host-runtime/orchestration/transcript-interval'

export async function matchesPiIdentity(path: string, cwd: string, sessionId: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const bytes = Buffer.allocUnsafe(16 * 1024)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const line = bytes.subarray(0, bytesRead)
    const end = line.indexOf(0x0a)
    if (end < 0) return false
    try {
      validateHeader(JSON.parse(line.toString('utf8', 0, end)) as NativeEntry, { cwd, sessionId })
      return true
    } catch {
      return false
    }
  } finally {
    await file.close()
  }
}

export async function locateOwnedTranscript(
  homeDir: string,
  cwd: string,
  provider: TranscriptSource['provider'],
  nativeSessionId: string
): Promise<TranscriptSource | undefined> {
  const path = provider === 'claude' ? transcriptPath(cwd, nativeSessionId, homeDir)
    : (await locatePiNativeSession({ sessionRoot: join(homeDir, '.pi', 'agent', 'sessions'), cwd, sessionId: nativeSessionId }))?.canonical
  if (!path || !trustedOwnedFile(homeDir, path)) return undefined
  if (provider === 'claude' && !resolveNativeTranscriptPath({ cwd, sessionId: nativeSessionId, home: homeDir })) return undefined
  if (provider === 'pi' && !(await matchesPiIdentity(path, cwd, nativeSessionId))) return undefined
  return { provider, nativeSessionId, path }
}
