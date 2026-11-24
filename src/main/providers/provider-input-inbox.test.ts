import { describe, expect, it } from 'vitest'
import { ProviderInputInboxBusyError, createProviderInputInbox } from './provider-input-inbox'

const message = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) as never

// C1: one Provider session serves several turns, so its input stream is shared. Exactly one reader
// may consume it, and a closed stream must release the waiter instead of hanging the run.

describe('Provider input inbox', () => {
  it('yields pushed messages in order and closes the stream', async () => {
    const inbox = createProviderInputInbox()
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
    const inbox = createProviderInputInbox()
    const first = inbox[Symbol.asyncIterator]()
    inbox.push(message('one'))
    await first.next()
    await expect(inbox[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ProviderInputInboxBusyError)
    inbox.close()
  })

  it('ignores a push after close', async () => {
    const inbox = createProviderInputInbox()
    inbox.close()
    inbox.push(message('late'))
    expect(await inbox[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  })
})

// C1 Qoder: the same channel carries Qoder's SDK messages, so a kept session is not Claude-only.
describe('Qoder input inbox', () => {
  it('carries Qoder user messages without the Claude SDK type', async () => {
    const inbox = createProviderInputInbox<{ type: 'user'; text: string }>()
    const iterator = inbox[Symbol.asyncIterator]()
    inbox.push({ type: 'user', text: '你好' })
    expect(await iterator.next()).toEqual({ value: { type: 'user', text: '你好' }, done: false })
    inbox.close()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })
})
