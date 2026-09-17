import type { TerminalRecordingPage, TerminalRecordingRequest } from '@shared/terminal'

// One page and one xterm write at a time; restarting/closing a pane cancels before the next write.
export async function replayTerminalRecording(
  id: string,
  read: (request: TerminalRecordingRequest) => Promise<TerminalRecordingPage>,
  write: (text: string) => Promise<void>,
  isCurrent: () => boolean
): Promise<TerminalRecordingPage | undefined> {
  let offset = 0
  while (isCurrent()) {
    const page = await read({ id, offset, limit: 64 * 1024 })
    if (!isCurrent()) return undefined
    if (page.data) await write(page.data)
    if (!isCurrent()) return undefined
    if (!page.hasMore) return page
    offset = page.nextOffset
  }
  return undefined
}
