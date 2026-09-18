import type { TerminalRecordingPage, TerminalRecordingRequest } from '@shared/terminal'

// One page and one xterm write at a time; restarting/closing a pane cancels before the next write.
export async function replayTerminalRecording(
  id: string,
  read: (request: TerminalRecordingRequest) => Promise<TerminalRecordingPage>,
  write: (text: string) => Promise<void>,
  isCurrent: () => boolean,
  endOffset?: number
): Promise<TerminalRecordingPage | undefined> {
  let offset = 0
  while (isCurrent()) {
    if (endOffset !== undefined && offset >= endOffset) return undefined
    const remaining = endOffset === undefined ? 64 * 1024 : Math.max(4, Math.min(64 * 1024, endOffset - offset))
    const page = await read({ id, offset, limit: remaining })
    if (!isCurrent()) return undefined
    if (page.data) await write(page.data)
    if (!isCurrent()) return undefined
    if (endOffset !== undefined && page.nextOffset >= endOffset) return page
    if (!page.hasMore) return page
    offset = page.nextOffset
  }
  return undefined
}
