import { Duplex, pipeline, Transform } from 'node:stream'
import { parser, type Token } from 'stream-json/parser.js'
import { stringer } from 'stream-json/stringer.js'

function redundantPayload(path: (string | number | null)[]): boolean {
  if (path.length === 1 && (path[0] === 'messages' || path[0] === 'toolResults')) return true
  if (path[0] !== 'data' || path[1] !== 'entries' || typeof path[2] !== 'number') return false
  if (path.length === 4) return !['id', 'parentId', 'type', 'message'].includes(String(path[3]))
  return path.length === 5 && path[3] === 'message' && path[4] !== 'role'
}

// Pi repeats live evidence in agent_end/turn_end. get_entries callers need only ancestry
// and roles, not another copy of every tool result. Project before assembling, not after
// JSON.parse. Skipped JSON is still syntax-checked; live evidence is never truncated.
export function createPiRpcDecoder(maxFrameBytes: number): Duplex {
  const encode = stringer({ useKeyValues: true })
  const path: (string | number | null)[] = []
  let skipDepth: number | undefined
  let keyBytes = 0
  let inKey = false
  let bytes = 0
  let parts: string[] = []
  const limitError = (): Error => new Error('Pi RPC 未完成 JSONL 消息超过 64 MiB 支持上限')
  const frames = new Transform({
    objectMode: true,
    transform(token: Token, _encoding, callback) {
      try {
        // Packed keys are needed for paths, but their streamed form lets us bound them
        // before the tokenizer finishes assembling a malicious/unbounded property name.
        if (token.name === 'startKey') { inKey = true; keyBytes = 0 }
        if (inKey && token.name === 'stringChunk') {
          keyBytes += Buffer.byteLength(token.value)
          if (keyBytes > maxFrameBytes) throw limitError()
        }
        if (token.name === 'endKey') { inKey = false; callback(); return }
        if (inKey) { callback(); return }
        if (path.length === 0 && token.name !== 'startObject') throw new Error('Pi RPC 返回了非对象 JSON 行')
        if (token.name === 'keyValue') {
          path[path.length - 1] = token.value
          if (skipDepth === path.length) skipDepth = undefined
          if (skipDepth === undefined && redundantPayload(path)) skipDepth = path.length
        }
        if (token.name === 'endObject' || token.name === 'endArray') {
          if (skipDepth === path.length) skipDepth = undefined
          path.pop()
        }
        if (skipDepth === undefined) {
          const part = encode(token)
          if (typeof part === 'string') {
            bytes += Buffer.byteLength(part)
            if (bytes > maxFrameBytes) throw limitError()
            parts.push(part)
          }
        }
        if (token.name === 'startObject' || token.name === 'startArray') {
          path.push(token.name === 'startArray' ? 0 : null)
          if (path.length > 1024) throw new Error('Pi RPC JSON 嵌套超过 1024 层支持上限')
        }
        if (path.length === 0) {
          this.push(JSON.parse(parts.join('')) as unknown)
          parts = []
          bytes = 0
        }
        callback()
      } catch (error) {
        callback(error as Error)
      }
    }
  })
  const input = parser.asStream({ jsonStreaming: true, packStrings: false, packNumbers: false })
  const decoder = Duplex.from({ writable: input, readable: frames })
  pipeline(input, frames, (error) => {
    if (error) decoder.destroy(error)
  })
  return decoder
}
