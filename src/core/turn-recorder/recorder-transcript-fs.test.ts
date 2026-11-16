import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_READ_ATTEMPTS,
  isTransientTranscriptError,
  withTranscriptRetry
} from './recorder-transcript-fs'

const errorWith = (code: string): NodeJS.ErrnoException => Object.assign(
  new Error(`${code}: simulated`),
  { code, syscall: 'open', path: '/tmp/transcript.jsonl' }
)

describe('transcript read retry policy', () => {
  it('retries a denied open and returns the later result', async () => {
    let calls = 0
    const value = await withTranscriptRetry(async () => {
      calls++
      if (calls < TRANSCRIPT_READ_ATTEMPTS) throw errorWith('EPERM')
      return 'read'
    }, { delayMs: 0 })
    expect(value).toBe('read')
    expect(calls).toBe(TRANSCRIPT_READ_ATTEMPTS)
  })

  it('gives up after the bounded attempts with the original denial', async () => {
    let calls = 0
    await expect(withTranscriptRetry(async () => {
      calls++
      throw errorWith('EPERM')
    }, { delayMs: 0 })).rejects.toMatchObject({ code: 'EPERM', syscall: 'open', path: '/tmp/transcript.jsonl' })
    expect(calls).toBe(TRANSCRIPT_READ_ATTEMPTS)
  })

  it('does not retry a permanent cause', async () => {
    let calls = 0
    for (const code of ['ENOENT', 'EACCES', 'EISDIR']) {
      await expect(withTranscriptRetry(async () => {
        calls++
        throw errorWith(code)
      }, { delayMs: 0 })).rejects.toMatchObject({ code })
    }
    expect(calls).toBe(3)
  })

  it('treats only codes that can clear on their own as transient', () => {
    expect(['EPERM', 'EINTR', 'EBUSY'].every(code => isTransientTranscriptError(errorWith(code)))).toBe(true)
    expect(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR'].some(code => isTransientTranscriptError(errorWith(code)))).toBe(false)
    expect(isTransientTranscriptError(new Error('nothing to do with the filesystem'))).toBe(false)
  })
})
