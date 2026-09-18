import { describe, expect, it, vi } from 'vitest'
import type { TerminalRecordingPage } from '@shared/terminal'
import { replayTerminalRecording } from './terminal-recording-replay'

const page = (offset: number, hasMore: boolean): TerminalRecordingPage => ({
  id: 'test', encoding: 'utf16le', data: 'hi', offset, nextOffset: offset + 4,
  totalBytes: 8, hasMore, state: 'complete'
})

describe('terminal disk replay', () => {
  it('does not read another page until xterm has consumed the current write', async () => {
    let finishWrite!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const read = vi.fn(async ({ offset }: { offset: number }) => page(offset, offset === 0))
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWrite = resolve
      entered()
    })).mockResolvedValue(undefined)
    const replay = replayTerminalRecording('test', read, write, () => true)
    await started
    expect(read).toHaveBeenCalledTimes(1)
    finishWrite()
    expect(await replay).toMatchObject({ nextOffset: 8, hasMore: false })
    expect(read).toHaveBeenNthCalledWith(2, { id: 'test', offset: 4, limit: 65536 })
  })

  it('stops at the attach checkpoint even when the live recording grows during replay', async () => {
    const read = vi.fn(async ({ offset }: { offset: number }) => ({ ...page(offset, true), totalBytes: 20 }))
    const write = vi.fn(async () => {})
    await replayTerminalRecording('test', read, write, () => true, 8)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenNthCalledWith(1, { id: 'test', offset: 0, limit: 8 })
    expect(read).toHaveBeenNthCalledWith(2, { id: 'test', offset: 4, limit: 4 })
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not write an in-flight page into a restarted or disposed pane', async () => {
    let current = true
    let resolve!: (page: TerminalRecordingPage) => void
    const read = () => new Promise<TerminalRecordingPage>((done) => { resolve = done })
    const write = vi.fn(async () => {})
    const replay = replayTerminalRecording('test', read, write, () => current)
    current = false
    resolve(page(0, true))
    expect(await replay).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('propagates an unavailable recording instead of presenting an empty successful replay', async () => {
    const write = vi.fn(async () => {})
    await expect(replayTerminalRecording('test', async () => { throw new Error('missing') }, write, () => true)).rejects.toThrow('missing')
    expect(write).not.toHaveBeenCalled()
  })
})
