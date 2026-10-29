// Pairing sequence for the live lane's private client peers (R6.3).
//
// Every peer is a separate real pairing attempt: its own host invitation, its own integer
// peer id, its own state directory. Peer ids stay integers because the client main validates
// payloads with parsePairPayload/parsePeerPayload (peer-${i} is a label, never an id), and the
// reply shapes read here are the ones runCommand really returns.
import { join } from 'node:path'

/** Identity of one peer: the id is an integer, the label and directory name are strings. */
export function peerIdentity(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error('peer index must be a non-negative integer')
  return { peerId: index, label: `peer-${index}`, directoryName: `peer-${index}` }
}

/**
 * Pairs `count` peers in order and returns their real connections and renderer pids.
 * Any reply that does not match the client main's actual shape throws: a peer is only
 * recorded as ready when its window really installed the fixture driver.
 */
export async function pairAllPeers({ count, client, host, stateRoot, report, log }) {
  if (!Number.isInteger(count) || count < 0) throw new Error('peer count must be a non-negative integer')
  const connections = []
  const renderers = []
  for (let index = 0; index < count; index++) {
    const identity = peerIdentity(index)
    const record = { peerIndex: index, peerId: identity.peerId, label: identity.label, status: 'pending' }
    // Registered before pairing, so a failed peer is still in the report.
    report.peers.push(record)
    // Pairing ids belong to one attempt: a shared invitation would let a second peer reuse
    // the first peer's pending grant.
    const invitation = await host.invite()
    record.invitation = { pairingId: invitation.pairingId, hostId: invitation.hostId, expiresAt: invitation.expiresAt }
    const paired = await client.pair({
      peerId: identity.peerId,
      label: identity.label,
      invitation: invitation.invitation,
      directory: join(stateRoot, identity.directoryName)
    })
    record.connectionId = paired.connectionId
    record.publicKeySHA256 = paired.publicKeySHA256
    const confirmation = await host.confirmPairing(invitation.pairingId, paired.publicKeySHA256)
    record.confirmation = confirmation
    if (confirmation?.revoked !== false) throw new Error(`peer ${index} pairing was not granted: ${JSON.stringify(confirmation)}`)
    const finished = await client.finish(identity.peerId)
    // runCommand('finish') answers `{peerId, connectionId, state}`; a caller reading some
    // other field would never observe 'paired' and would silently proceed.
    if (finished?.state !== 'paired') throw new Error(`peer ${index} did not finish pairing: ${JSON.stringify(finished)}`)
    record.finished = finished
    const window = await client.openWindow(identity.peerId)
    if (window?.driverInstalled !== true) throw new Error(`peer ${index} window did not install the fixture driver: ${JSON.stringify(window)}`)
    record.window = window
    record.rendererPid = Number.isInteger(window.rendererPid) ? window.rendererPid : null
    // Pairing, host confirmation, finish and the window mount all cost TLS work, and the client
    // counters are reset on read: one read here keeps that setup traffic out of the first
    // measured visit (it used to show up as visit.counters.tls with pairing requests and
    // tunnel opens). Every later visit still reads its own counters as before.
    record.setupCounters = await client.counters(identity.peerId)
    record.status = 'ready'
    connections.push(paired.connectionId)
    renderers.push(record.rendererPid)
    log?.('client', `peer ${index} paired on ${paired.connectionId}, renderer pid ${record.rendererPid ?? 'unavailable'}`)
  }
  return { connections, renderers, peers: report.peers }
}
