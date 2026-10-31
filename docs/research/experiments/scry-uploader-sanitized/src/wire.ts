import { gzipSync } from 'node:zlib'

export function encodeRecordForWire(recordJson: string): string {
  const raw = Buffer.from(recordJson)
  const envelope = JSON.stringify({
    scryEncoding: 'gzip-base64',
    payload: gzipSync(raw, { level: 9 }).toString('base64')
  })
  return Buffer.byteLength(envelope) < raw.length ? envelope : recordJson
}
