import { describe, expect, it } from 'vitest'
import {
  DAEMON_FORWARD_CHANNELS, DAEMON_LOCAL_OP_CHANNELS, DAEMON_MODE_IN_PROCESS_CHANNELS, DAEMON_MODE_SERVED_CHANNELS
} from '../daemon-channel-gate'
import { daemonOwnedChannels, registerDaemonOwnedChannels } from './daemon-owned-channels'
import type { TrustedRegistrar } from './agent-runtime-ipc'

// The channels the App registers only so the daemon gate can forward them: every channel
// the daemon answers, minus those the App answers or serves itself, each exactly once.

describe('daemon-owned channels', () => {
  it('lists every daemon channel except the ones the App answers or serves itself', () => {
    const owned = daemonOwnedChannels()
    const all = new Set([...Object.keys(DAEMON_LOCAL_OP_CHANNELS), ...Object.keys(DAEMON_FORWARD_CHANNELS)])
    expect(new Set(owned).size).toBe(owned.length)
    for (const channel of owned) {
      expect(all.has(channel)).toBe(true)
      expect(DAEMON_MODE_IN_PROCESS_CHANNELS.has(channel)).toBe(false)
      expect(DAEMON_MODE_SERVED_CHANNELS.has(channel)).toBe(false)
    }
    for (const channel of all) {
      if (!DAEMON_MODE_IN_PROCESS_CHANNELS.has(channel) && !DAEMON_MODE_SERVED_CHANNELS.has(channel)) expect(owned).toContain(channel)
    }
    expect(owned).toContain('conversation:read')
    expect(owned).not.toContain('agent:setCwd')
  })

  it('registers each one once, skips those the App registered, and never answers locally', () => {
    const owned = daemonOwnedChannels()
    const already = new Set([owned[0]!])
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const handleTrusted: TrustedRegistrar = (channel, listener) => {
      expect(listeners.has(channel)).toBe(false)
      listeners.set(channel, listener as (...args: unknown[]) => unknown)
    }
    registerDaemonOwnedChannels(handleTrusted, already)
    expect([...listeners.keys()].sort()).toEqual(owned.filter((channel) => !already.has(channel)).sort())
    const [channel, listener] = [...listeners.entries()][0]!
    expect(() => listener({})).toThrow(`daemon_capability_unavailable:${channel}`)
  })
})
