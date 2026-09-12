// Generated from wire.schema.json. Do not edit.
const schemas = {
  "ProbeRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "operation",
      "payload"
    ],
    "properties": {
      "protocolMajor": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "operation": {
        "type": "string",
        "enum": [
          "probe.echo"
        ]
      },
      "payload": {
        "type": "string",
        "maxLength": 4096
      }
    }
  },
  "ProbeResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "kind",
      "payload"
    ],
    "properties": {
      "protocolMajor": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "kind": {
        "type": "string",
        "enum": [
          "result"
        ]
      },
      "payload": {
        "type": "string",
        "maxLength": 4096
      }
    }
  }
}

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
