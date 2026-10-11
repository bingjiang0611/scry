// Prototype-only sample extraction. Reads local Pi session files (not Scry runtime data) and
// writes per-turn token-speed samples to data.js. Production collection lives in the adapters.
// Speed = Σ provider-reported output tokens / Σ local call duration (request start → message end).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), '.pi/agent/sessions')
const since = Date.now() - 7 * 86400_000
const turns = []

for (const dir of readdirSync(root)) {
  const folder = join(root, dir)
  if (!statSync(folder).isDirectory()) continue
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.jsonl') || statSync(join(folder, file)).mtimeMs < since) continue
    let turn
    const flush = () => { if (turn?.calls || turn?.failed) turns.push(turn); turn = undefined }
    for (const line of readFileSync(join(folder, file), 'utf8').split('\n')) {
      if (!line.includes('"message"')) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const message = entry.message
      if (message?.role === 'user') { flush(); continue }
      if (message?.role !== 'assistant' || !message.usage || typeof message.timestamp !== 'number') continue
      const end = Date.parse(entry.timestamp)
      const duration = end - message.timestamp
      if (!(duration > 0) || end < since || typeof message.usage.output !== 'number') continue
      turn ??= { t: end, model: `${message.provider}/${message.model}`, calls: 0, tok: 0, dur: 0, failed: false }
      turn.t = end
      // Pi retries errored calls inside the same turn; only the last call decides the outcome,
      // and errored/aborted calls never contribute to speed.
      turn.failed = message.stopReason === 'error' || message.stopReason === 'aborted'
      if (turn.failed) continue
      turn.calls++
      turn.tok += message.usage.output
      turn.dur += duration
    }
    flush()
  }
}

turns.sort((a, b) => a.t - b.t)
writeFileSync(new URL('./data.js', import.meta.url), `window.SAMPLE = ${JSON.stringify({ generatedAt: Date.now(), turns })}\n`)
console.log(`turns=${turns.length}`)
