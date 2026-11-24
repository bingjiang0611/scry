import { describe, expect, it } from 'vitest'
import { ClaudeInputInboxBusyError, createClaudeInputInbox } from './claude-input-inbox'

const message = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) as never

// C1: one Claude session serves several turns, so its input stream is shared. Exactly one reader
// may consume it, and a closed stream must release the waiter instead of hanging the run.

describe('claude input inbox', () => {
  it('yields pushed messages in order and closes the stream', async () => {
    const inbox = createClaudeInputInbox()
    const iterator = inbox[Symbol.asyncIterator]()
    inbox.push(message('one'))
    inbox.push(message('two'))
    expect(await iterator.next()).toMatchObject({ value: { message: { content: 'one' } }, done: false })
    expect(await iterator.next()).toMatchObject({ value: { message: { content: 'two' } }, done: false })
    const pending = iterator.next()
    inbox.close()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(inbox.closed).toBe(true)
  })

  it('refuses a second concurrent reader', async () => {
    const inbox = createClaudeInputInbox()
    const first = inbox[Symbol.asyncIterator]()
    inbox.push(message('one'))
    await first.next()
    await expect(inbox[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ClaudeInputInboxBusyError)
    inbox.close()
  })

  it('ignores a push after close', async () => {
    const inbox = createClaudeInputInbox()
    inbox.close()
    inbox.push(message('late'))
    expect(await inbox[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  })
})
