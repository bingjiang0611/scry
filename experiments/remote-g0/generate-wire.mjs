import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Deliberately small JSON Schema subset for the G0 probe, not a general codegen
// promise. Unsupported schema shapes fail the build instead of silently drifting.
const root = new URL('./', import.meta.url)
const schema = JSON.parse(await readFile(new URL('wire.schema.json', root), 'utf8'))
const models = Object.entries(schema.$defs)
for (const [name, model] of models) {
  if (Object.keys(model).some(key => !['type', 'additionalProperties', 'required', 'properties'].includes(key)) ||
      !/^[A-Z][A-Za-z]+$/.test(name) || model.type !== 'object' || model.additionalProperties !== false ||
      JSON.stringify(Object.keys(model.properties).sort()) !== JSON.stringify([...model.required].sort())) throw new Error('unsupported object schema')
  for (const [key, field] of Object.entries(model.properties)) {
    if (!/^[a-z][A-Za-z]+$/.test(key) || !['string', 'integer'].includes(field.type)) throw new Error('unsupported field')
    if (Object.keys(field).some(key => !['type', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum'].includes(key))) throw new Error('unsupported constraint')
  }
}
const js = `// Generated from wire.schema.json. Do not edit.\nconst schemas = ${JSON.stringify(schema.$defs, null, 2)}\n
export function decodeWire(name, input) {
  const schema = schemas[name]
  if (!schema || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid wire object')
  if (Object.keys(input).length !== schema.required.length || Object.keys(input).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('unexpected wire fields')
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = input[key]
    if (rule.type === 'string') {
      if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('invalid string: ' + key)
      const length = Array.from(value).length
      if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity)) throw new Error('invalid length: ' + key)
    } else if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) throw new Error('invalid integer: ' + key)
    if (rule.enum && !rule.enum.includes(value)) throw new Error('invalid enum: ' + key)
  }
  return input
}
`
const ts = '// Generated from wire.schema.json. Do not edit.\n' + models.map(([name, model]) => `export interface ${name} {\n${Object.entries(model.properties).map(([key, rule]) => `  ${key}: ${rule.enum ? rule.enum.map(value => JSON.stringify(value)).join(' | ') : rule.type === 'integer' ? 'number' : 'string'}`).join('\n')}\n}`).join('\n\n') + '\n'
function swiftType(rule) { return rule.type === 'integer' ? 'Int' : 'String' }
function swiftChecks(key, rule) {
  const checks = rule.type === 'integer' ? [`${key} >= ${rule.minimum}`, `${key} <= ${rule.maximum}`] : [
    `${key}.unicodeScalars.count >= ${rule.minLength ?? 0}`,
    ...(rule.maxLength === undefined ? [] : [`${key}.unicodeScalars.count <= ${rule.maxLength}`])
  ]
  if (rule.enum) checks.push(`[${rule.enum.map(value => JSON.stringify(value)).join(', ')}].contains(${key})`)
  return `    guard ${checks.join(', ')} else { throw WireError.invalidField(${JSON.stringify(key)}) }`
}
const swift = `// Generated from wire.schema.json. Do not edit.\nimport Foundation\n\nenum WireError: Error { case invalidFields; case invalidField(String) }\nprivate struct WireKey: CodingKey {\n  let stringValue: String\n  let intValue: Int? = nil\n  init?(stringValue: String) { self.stringValue = stringValue }\n  init?(intValue: Int) { return nil }\n}\n\n` + models.map(([name, model]) => {
  const fields = Object.entries(model.properties)
  return `struct ${name}: Codable, Sendable {\n${fields.map(([key, rule]) => `  let ${key}: ${swiftType(rule)}`).join('\n')}\n  private enum CodingKeys: String, CodingKey { case ${fields.map(([key]) => key).join(', ')} }\n  init(${fields.map(([key, rule]) => `${key}: ${swiftType(rule)}`).join(', ')}) throws {\n${fields.map(([key]) => `    self.${key} = ${key}`).join('\n')}\n    try validate()\n  }\n  init(from decoder: Decoder) throws {\n    let all = try decoder.container(keyedBy: WireKey.self)\n    guard Set(all.allKeys.map(\\.stringValue)) == Set([${fields.map(([key]) => JSON.stringify(key)).join(', ')}]) else { throw WireError.invalidFields }\n    let values = try decoder.container(keyedBy: CodingKeys.self)\n${fields.map(([key, rule]) => `    ${key} = try values.decode(${swiftType(rule)}.self, forKey: .${key})`).join('\n')}\n    try validate()\n  }\n  private func validate() throws {\n${fields.map(([key, rule]) => swiftChecks(key, rule)).join('\n')}\n  }\n}`
}).join('\n\n') + '\n'
for (const [path, content] of [
  ['generated/wire.mjs', js], ['generated/wire.ts', ts], ['swift/Sources/RemoteProbe/Wire.swift', swift]
]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8') !== content) throw new Error('generated artifact drift: ' + path)
  } else {
    await mkdir(dirname(fileURLToPath(destination)), { recursive: true })
    await writeFile(destination, content)
  }
}
console.log(process.argv.includes('--check') ? 'Wire artifacts match schema' : 'Generated JS validator, TS DTOs and Swift Codable models')
