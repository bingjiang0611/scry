import { rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { setup, ssh, statusRun, statusSnapshot } from './desktop-client-fixtures'

// D1: the host publishes queued runs so every client can show the same queue. A device that
// rejects the new lifecycle would drop the whole snapshot, so this pins acceptance and shape.

it('accepts a queued run row with its slot and hold', async () => {
  let hostId = ''
  const run = statusRun('run-queue1-abc', { lifecycle: 'queued', queuePosition: 2, queueHeld: true })
  const fixture = await setup({
    // A known cursor is a long poll: keep it pending so the fixture does not spin.
    subscribeResponse: (request) => request.known
      ? new Promise<never>(() => {})
      : statusSnapshot(hostId, { runs: [run] })
  })
  hostId = fixture.host.hostId
  try {
    const pending = await fixture.client.pair({ label: 'Queue', ssh, invitation: fixture.invitation })
    const id = pending.connection.id
    await fixture.client.finishPairing(id)
    await fixture.client.connect(id)
    const row = await fixture.client.runStatus(id, 'run-queue1-abc')
    expect(row).toMatchObject({ state: 'queued', queuePosition: 2, queueHeld: true })
    await fixture.client.disconnect(id)
  } finally {
    await fixture.client.dispose()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
