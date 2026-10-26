import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

// Domain files are one level deep. Old, single-file ledgers remain valid baseline inputs.
function ledgerParts(path) {
  const root = { path, value: readJson(path) }
  const includes = root.value.includes ?? []
  if (!Array.isArray(includes) || includes.some(file => typeof file !== 'string' || !file)) {
    throw new Error('Ledger includes must list domain files')
  }
  const parts = includes.map(file => {
    const childPath = resolve(dirname(path), file)
    const value = readJson(childPath)
    if (value.schema !== root.value.schema || value.includes !== undefined) {
      throw new Error(`Ledger domain must use the root schema without nested includes: ${file}`)
    }
    return { path: childPath, value }
  })
  return [root, ...parts]
}

export function readLedger(path) {
  const parts = ledgerParts(path)
  const metrics = {}
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.value.metrics)) {
      if (Object.hasOwn(metrics, key)) throw new Error(`Duplicate ledger metric: ${key}`)
      metrics[key] = value
    }
  }
  return { schema: parts[0].value.schema, metrics }
}

export function writeLedger(path, ledger) {
  const parts = ledgerParts(path)
  const registered = parts.flatMap(part => Object.keys(part.value.metrics))
  if (new Set(registered).size !== registered.length) throw new Error('Duplicate ledger metric')
  if (registered.length !== Object.keys(ledger.metrics).length || registered.some(key => !Object.hasOwn(ledger.metrics, key))) {
    throw new Error('Register metric keys in their domain file before proposing baselines')
  }
  for (const part of parts) {
    const value = {
      ...part.value,
      metrics: Object.fromEntries(Object.keys(part.value.metrics).map(key => [key, ledger.metrics[key]]))
    }
    if (JSON.stringify(value) !== JSON.stringify(part.value)) {
      writeFileSync(part.path, `${JSON.stringify(value, null, 2)}\n`)
    }
  }
}
