// Deliberately incorrect, generated-only backend. Native fact A is staged but
// ACKed without COMMIT; subsequent root updates and frame B share that actual
// SQLite transaction. B's real CAS rejection must ROLLBACK the staged A.
const boundedTrace = prefix => `let negativeTraceCount = 0
function negativeTrace(text: string) {
  if (++negativeTraceCount <= 128) console.log('${prefix}', text)
  else if (negativeTraceCount === 129) console.log('${prefix}', JSON.stringify({ event: 'trace_truncated', limit: 128 }))
}
`
export function mergeNativeTransactions(runtime, worker, replace) {
  runtime = replace(runtime, '  private tail = Promise.resolve()', '  private pendingNativeFact = false\n  private tail = Promise.resolve()')
  runtime = replace(runtime, 'async transaction<T>(run: () => Promise<T>)', 'async transaction<T>(run: () => Promise<T>, frame = false)')
  runtime = replace(runtime, "      await this.worker.request({ op: 'begin' })", `      if (!this.pendingNativeFact) await this.worker.request({ op: 'begin' })
      else console.log('CHECKPOINT_NEGATIVE_AB', JSON.stringify({ event: 'joined', frame }))`)
  runtime = replace(runtime, "        try { await this.worker.request({ op: 'commit' }) }", `        if (this.pendingNativeFact && !frame) return value // Intentionally lie about durable A.
        try { await this.worker.request({ op: 'commit' }); this.pendingNativeFact = false }`)
  runtime = replace(runtime, "          try { await this.worker.request({ op: 'rollback' }) }", `          try {
            await this.worker.request({ op: 'rollback' })
            if (this.pendingNativeFact) console.log('CHECKPOINT_NEGATIVE_AB', JSON.stringify({ event: 'rolled_back' }))
            this.pendingNativeFact = false
          }`)
  runtime = replace(runtime, "    await this.worker.request({ op: 'put', name, text })", `    if (!this.pendingNativeFact && /^[A-Za-z0-9_-]{1,96}\\.json$/.test(name)) {
      const record = JSON.parse(text) as { progress?: { state?: string }; systemOutcomes?: Array<{ state?: string; settled?: boolean }> }
      if (record.progress?.state === 'running' && record.systemOutcomes?.some(outcome => outcome.state === 'completed' && outcome.settled)) {
        this.pendingNativeFact = true
        console.log('CHECKPOINT_NEGATIVE_AB', JSON.stringify({ event: 'native_fact_staged', name }))
      }
    }
    await this.worker.request({ op: 'put', name, text })`)
  runtime = replace(runtime, '.transaction(run)\n}', ".transaction(run, basename(dirname(lock)) === 'locks')\n}")
  worker = replace(worker, 'let active = false, closed = false, fault:', 'let negativeTransactionId = 0\nlet negativeNativeRoot: string | undefined\nlet active = false, closed = false, fault:')
  worker = replace(worker, "db.exec('BEGIN IMMEDIATE'); active = true; break", `db.exec('BEGIN IMMEDIATE'); active = true; negativeTransactionId++
        console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'begin', transaction: negativeTransactionId, active: db.isTransaction })); break`)
  worker = replace(worker, '        counters.gets++', `        counters.gets++
        console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'get', transaction: negativeTransactionId, name: request.name }))`)
  worker = replace(worker, '        put.run(request.name, request.text, digest(request.text));', `        console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'put', transaction: negativeTransactionId, name: request.name }))
        if (/^[A-Za-z0-9_-]{1,96}\\.json$/.test(request.name)) {
          const record = JSON.parse(request.text) as { progress?: { state?: string }; systemOutcomes?: Array<{ state?: string; settled?: boolean }> }
          if (record.progress?.state === 'running' && record.systemOutcomes?.some(outcome => outcome.state === 'completed' && outcome.settled)) negativeNativeRoot = request.name
        }
        put.run(request.name, request.text, digest(request.text));`)
  worker = replace(worker, '        active = false; counters.transactions++', `        active = false; counters.transactions++
        console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'commit', transaction: negativeTransactionId, active: db.isTransaction }))`)
  worker = replace(worker, "        if (active) db.exec('ROLLBACK')\n        active = false; break", `        const wasTransaction = db.isTransaction
        if (active) db.exec('ROLLBACK')
        active = false
        console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'rollback', transaction: negativeTransactionId, wasTransaction, active: db.isTransaction }))
        if (negativeNativeRoot) {
          const reader = new DatabaseSync(path, { readOnly: true })
          try {
            const row = reader.prepare('SELECT body FROM metadata WHERE name=?').get(negativeNativeRoot)
            if (!row || typeof row.body !== 'string') throw new Error('negative control missing canonical root')
            const record = JSON.parse(row.body) as { systemOutcomes?: Array<{ state?: string; settled?: boolean }> }
            const nativeFactCommitted = record.systemOutcomes?.some(outcome => outcome.state === 'completed' && outcome.settled) ?? false
            console.log('CHECKPOINT_NEGATIVE_SQL', JSON.stringify({ op: 'cold_read_after_rollback', transaction: negativeTransactionId, nativeFactCommitted }))
          } finally { reader.close() }
        }
        break`)
  runtime = runtime.replaceAll("console.log('CHECKPOINT_NEGATIVE_AB', ", 'negativeTrace(')
  worker = worker.replaceAll("console.log('CHECKPOINT_NEGATIVE_SQL', ", 'negativeTrace(')
  runtime = replace(runtime, 'class Runtime {', boundedTrace('CHECKPOINT_NEGATIVE_AB') + 'class Runtime {')
  worker = replace(worker, 'let negativeTransactionId = 0', boundedTrace('CHECKPOINT_NEGATIVE_SQL') + 'let negativeTransactionId = 0')
  return { runtime, worker }
}
