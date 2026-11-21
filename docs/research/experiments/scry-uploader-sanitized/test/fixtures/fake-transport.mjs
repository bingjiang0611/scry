#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const command = args.filter((arg) => arg !== '--no-update-check')

if (command[0] === 'version') {
  process.stdout.write('transport version 9.9.9\n')
  process.exit(0)
}

if (command[0] === 'auth' && command[1] === 'whoami') {
  process.stdout.write(
    JSON.stringify({ subject_id: '123456', nickname: '测试用户', name: 'Test User', account: 'test' })
  )
  process.exit(0)
}

if (command[0] === 'mcp' && command[1] === 'list-tools') {
  process.stdout.write(
    JSON.stringify([
      {
        name: 'submitTurns',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            [
              'actorUserId',
              'actorNick',
              'repo',
              'installationId',
              'uploaderVersion',
              'redactionVersion',
              'records'
            ].map((key) => [key, {}])
          )
        }
      }
    ])
  )
  process.exit(0)
}

if (command[0] === 'mcp' && command[1] === 'call-tool') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const payload = JSON.parse(input)
  if (command[2] === 'agent-trace-service::queryAgentTurnUploadCapabilities') {
    if (process.env.FAKE_TRANSPORT_MODE === 'capability-error') {
      process.stderr.write('mcp error: unknown tool "queryAgentTurnUploadCapabilities" token=sk-live-abcdef\n')
      process.exit(1)
    }
    process.stdout.write(JSON.stringify({ success: true, data: process.env.FAKE_TRANSPORT_MODE === 'no-content'
      ? {} : { contentProtocol: 'recorder-content-v1', maxDecodedRecordBytes: 16 * 1024 * 1024 } }))
    process.exit(0)
  }
  const records = payload.records ?? []
  const packets = records.map((raw) => {
    const parsed = JSON.parse(raw)
    return parsed.scryEncoding === 'gzip-base64'
      ? JSON.parse(gunzipSync(Buffer.from(parsed.payload, 'base64')).toString('utf8'))
      : parsed
  })
  const contents = packets.map(packet => packet.scryEncoding === 'recorder-content-v1' ? packet.contentJson : null)
  const decoded = packets.map(packet => packet.scryEncoding === 'recorder-content-v1' ? JSON.parse(packet.recordJson) : packet)
  for (const content of contents) {
    if (content === null) continue
    for (const blob of JSON.parse(content)) {
      const raw = Buffer.from(blob.dataBase64, 'base64')
      if (raw.length !== blob.bytes || createHash('sha256').update(raw).digest('hex') !== blob.sha256)
        throw new Error('fake receiver rejected corrupt body')
    }
  }
  if (process.env.FAKE_TRANSPORT_LOG)
    appendFileSync(process.env.FAKE_TRANSPORT_LOG, `${JSON.stringify({ payload, decoded, contents })}\n`)
  if (process.env.FAKE_TRANSPORT_FAILS_LEFT_FILE) {
    const remaining = Number(readFileSync(process.env.FAKE_TRANSPORT_FAILS_LEFT_FILE, 'utf8'))
    if (remaining > 0) {
      writeFileSync(process.env.FAKE_TRANSPORT_FAILS_LEFT_FILE, `${remaining - 1}\n`)
      process.stderr.write('simulated temporary failure\n')
      process.exit(1)
    }
  }
  if (process.env.FAKE_TRANSPORT_MODE === 'timeout') {
    process.stderr.write('simulated report timeout\n')
    process.exit(1)
  }
  if (process.env.FAKE_TRANSPORT_MODE === 'fail') {
    process.stderr.write('simulated failure\n')
    process.exit(1)
  }
  let responseStatus = 'inserted'
  if (process.env.FAKE_TRANSPORT_COMMITTED_FILE) {
    let committed = new Set()
    try {
      committed = new Set(
        readFileSync(process.env.FAKE_TRANSPORT_COMMITTED_FILE, 'utf8').trim().split('\n').filter(Boolean)
      )
    } catch {}
    const missing = decoded.filter((record) => !committed.has(record.recordId))
    if (missing.length) {
      for (const record of missing) committed.add(record.recordId)
      writeFileSync(process.env.FAKE_TRANSPORT_COMMITTED_FILE, `${[...committed].join('\n')}\n`)
      process.stderr.write('simulated lost response after remote commit\n')
      process.exit(1)
    }
    responseStatus = 'duplicated'
  }
  if (['rejected', 'conflicted'].includes(process.env.FAKE_TRANSPORT_MODE)) responseStatus = process.env.FAKE_TRANSPORT_MODE
  const items = decoded.map((record, index) => ({ index, recordId: record.recordId, status: responseStatus,
    ...(contents[index] && process.env.FAKE_TRANSPORT_MODE !== 'content-ack-missing' ? {
      contentSha256: process.env.FAKE_TRANSPORT_MODE === 'content-ack-corrupt' ? '0'.repeat(64)
        : createHash('sha256').update(contents[index]).digest('hex')
    } : {})
  }))
  process.stdout.write(
    JSON.stringify({
      success: true,
      data: {
        received: items.length,
        inserted: responseStatus === 'inserted' ? items.length : 0,
        duplicated: responseStatus === 'duplicated' ? items.length : 0,
        conflicted: responseStatus === 'conflicted' ? items.length : 0,
        rejected: responseStatus === 'rejected' ? items.length : 0,
        items
      }
    })
  )
  process.exit(0)
}

process.stderr.write(`unexpected fake transport command: ${command.join(' ')}\n`)
process.exit(2)
