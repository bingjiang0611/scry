import { describe, expect, it } from 'vitest'
import { templateSourceDifference, templateStructure } from './workflow-template-review'

describe('same-source bounded template review projections', () => {
  it('shows the exact changed span without dropping prompt/default/condition changes or claiming minimum edits', () => {
    expect(templateSourceDifference('a\nold\nz', 'a\nnew\nz')).toEqual({ prefix: 1, suffix: 1, removed: 'old', added: 'new', removedLines: 1, addedLines: 1 })
    expect(templateSourceDifference('same', 'same')).toMatchObject({ removed: '', added: '', removedLines: 0, addedLines: 0 })
    const before = 'prefix\nold prompt\nunchanged\nold budget\nsuffix', after = 'prefix\nnew prompt\nunchanged\nnew budget\nsuffix'
    const diff = templateSourceDifference(before, after)
    expect(diff.removed).toBe('old prompt\nunchanged\nold budget'); expect(diff.added).toBe('new prompt\nunchanged\nnew budget')
    expect(templateSourceDifference('', 'new')).toMatchObject({ added: 'new', addedLines: 1 })
  })
  it('retains control nesting and actual data references, excluding expression-local filter items', () => {
    const rows = templateStructure({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'selected', value: { kind: 'filter', items: { kind: 'ref', name: 'source' }, item: 'item', when: { kind: 'compare', operator: 'eq', left: { kind: 'ref', name: 'item' }, right: { kind: 'ref', name: 'expected' } } } },
      { kind: 'branch', blockId: 'branch', when: { kind: 'ref', name: 'ready' }, unknown: 'blocked', then: { kind: 'call', blockId: 'call', role: 'worker', prompt: 'Prompt', inputRefs: [{ nodeId: 'selected', path: ['matched'] }] }, else: { kind: 'bind', blockId: 'empty', value: { kind: 'literal', value: [] } } },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'branch' } }
    ] })
    expect(rows.map(row => [row.id, row.depth])).toEqual([['root', 0], ['selected', 1], ['branch', 1], ['call', 2], ['empty', 2], ['finish', 1]])
    expect(rows[1].inputs).toEqual(['source', 'expected']); expect(rows[2].inputs).toEqual(['ready']); expect(rows[3].inputs).toEqual(['selected.matched'])
    expect(rows[5].inputs).toEqual(['branch'])
  })
})
