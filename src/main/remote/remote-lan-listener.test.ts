import { createServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { advertisableAddress, lanAddresses, RemoteLanListener } from './remote-lan-listener'

describe('RemoteLanListener', () => {
  it('advertises only private and overlay IPv4 addresses, LAN first', () => {
    expect(advertisableAddress('192.168.1.5')).toBe(true)
    expect(advertisableAddress('10.2.3.4')).toBe(true)
    expect(advertisableAddress('172.16.0.1')).toBe(true)
    expect(advertisableAddress('172.32.0.1')).toBe(false)
    expect(advertisableAddress('100.101.1.1')).toBe(true)
    expect(advertisableAddress('100.128.0.1')).toBe(false)
    expect(advertisableAddress('8.8.8.8')).toBe(false)
    expect(advertisableAddress('169.254.1.1')).toBe(false)
    const entry = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never
    expect(lanAddresses({
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      utun3: [entry('100.90.1.2')],
      en0: [entry('192.168.1.5'), entry('fe80::1', 'IPv6')],
      en7: [entry('203.0.113.9')]
    })).toEqual(['192.168.1.5', '100.90.1.2'])
    // Measured on a Mac off Wi-Fi: its only private addresses were corporate
    // VPN tunnels, which the phone timed out on. They are not advertised.
    const withMask = (address: string, netmask: string) =>
      ({ address, family: 'IPv4', internal: false, netmask, mac: '', cidr: null }) as never
    expect(lanAddresses({
      en0: [withMask('203.0.113.7', '255.255.224.0')],
      utun13: [withMask('172.18.0.1', '255.255.0.0')],
      utun5: [withMask('192.168.255.254', '255.255.255.255')],
      ppp0: [withMask('10.8.0.6', '255.255.255.0')],
      bridge100: [withMask('192.168.2.1', '255.255.255.0')],
      en1: [withMask('10.0.0.9', '255.255.255.255')],
      utun4: [withMask('100.101.5.6', '255.255.255.255')]
    })).toEqual(['100.101.5.6'])
  })

  it('serves accepted sockets, falls back from an occupied port and reports nothing when closed', async () => {
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    const taken = (blocker.address() as { port: number }).port
    const served: Socket[] = []
    const listener = new RemoteLanListener((socket) => { served.push(socket); socket.end('hi') }, {
      interfaces: () => ({ en0: [{ address: '192.168.7.7', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null } as never] })
    })
    try {
      const port = await listener.listen(taken, '127.0.0.1')
      expect(port).not.toBe(taken)
      expect(listener.advertisement()).toEqual({ port, addresses: ['192.168.7.7'] })
      const client = connect(port, '127.0.0.1')
      let text = ''
      client.on('data', (chunk: Buffer) => { text += chunk.toString() })
      await once(client, 'close')
      expect(text).toBe('hi')
      expect(served).toHaveLength(1)
      // A held connection must not block shutdown. Shutdown destroys the server
      // side of it, so the client sees ECONNRESET; swallow it instead of letting
      // an unhandled 'error' fail the run.
      const held = connect(port, '127.0.0.1')
      held.on('error', () => {})
      await once(held, 'connect')
    } finally {
      await listener.close()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    expect(listener.advertisement()).toBeUndefined()
  })
})
