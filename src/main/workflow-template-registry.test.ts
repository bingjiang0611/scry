import { describe, expect, it } from 'vitest'
import { projectTemplate, portableBuiltinTemplate, workflowTemplateRegistry } from './workflow-template-registry'

describe('canonical workflow template registry', () => {
  it('exposes four immutable portable families and two project factories', () => {
    const entries = workflowTemplateRegistry()
    expect(entries).toHaveLength(6)
    expect(entries.filter(entry => entry.kind === 'builtin')).toHaveLength(4)
    const first = portableBuiltinTemplate('code_audit')
    first.name = 'changed'
    expect(portableBuiltinTemplate('code_audit').name).not.toBe('changed')
  })
  it('freezes literal project check input through the existing factory', () => {
    const input = { argv: ['node', 'check.js'], cwd: '.', timeoutMs: 1000, parser: 'exit_code' as const }
    const template = projectTemplate('check_fix', input)
    const check = template.body.blocks.find(block => block.kind === 'check')
    expect(check && check.kind === 'check' ? check.check : undefined).toEqual(input)
    input.argv[0] = 'changed'
    expect(check && check.kind === 'check' ? check.check.argv[0] : undefined).toBe('node')
  })
})
