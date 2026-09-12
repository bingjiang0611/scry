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
  },
  "PairProofRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "operation",
      "pairingId",
      "secret",
      "csrPEM",
      "deviceLabel"
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
          "pair.prove"
        ]
      },
      "pairingId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "secret": {
        "type": "string",
        "minLength": 43,
        "maxLength": 43
      },
      "csrPEM": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "deviceLabel": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      }
    }
  },
  "PairStatusRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "operation",
      "pairingId",
      "secret"
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
          "pair.status"
        ]
      },
      "pairingId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "secret": {
        "type": "string",
        "minLength": 43,
        "maxLength": 43
      }
    }
  },
  "PairPendingResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "kind",
      "pairingId",
      "publicKeySHA256"
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
          "pair.pending"
        ]
      },
      "pairingId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "publicKeySHA256": {
        "type": "string",
        "minLength": 64,
        "maxLength": 64
      }
    }
  },
  "PairGrantedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "kind",
      "pairingId",
      "deviceId",
      "certificatePEM",
      "certificateSHA256",
      "expiresAt",
      "scope"
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
          "pair.granted"
        ]
      },
      "pairingId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "deviceId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "certificatePEM": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "certificateSHA256": {
        "type": "string",
        "minLength": 64,
        "maxLength": 64
      },
      "expiresAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "scope": {
        "type": "string",
        "enum": [
          "g0_echo_only"
        ]
      }
    }
  },
  "PairRevokedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "kind",
      "pairingId",
      "deviceId"
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
          "pair.revoked"
        ]
      },
      "pairingId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      },
      "deviceId": {
        "type": "string",
        "minLength": 36,
        "maxLength": 36
      }
    }
  },
  "PairDeniedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocolMajor",
      "requestId",
      "kind",
      "code"
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
          "pair.denied"
        ]
      },
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
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
