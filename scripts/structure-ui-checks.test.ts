import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { exerciseStructure } from './structure-ui-checks.mjs'

describe('structure campaign new-conversation readiness', () => {
  it('waits for the draft commit and its entrance before resetting the session-entry counter', async () => {
    // Model only this boundary: input dispatch precedes its renderer commit.
    // Other campaign assertions are covered by the real production-DOM replay.
    const state = { phase: 'before', target: '', reads: 0, draft: false, animating: false }
    const window = { structureEntries: [] as Array<{ id: string }> }
    const document = {
      querySelector: (selector: string) => selector === '.main-content .chat-transcript .unbound-empty' && state.draft ? {} : null,
      getAnimations: () => state.animating ? [{ id: 'scry-structure' }] : []
    }
    const selectionOrder: string[] = []
    const entryCount = "window.structureEntries.filter(animation => animation.id === 'scry-structure').length === 1"
    const contents = {
      executeJavaScript: async (expression: string) => {
        let result: unknown = true
        if (expression.includes('getBoundingClientRect')) {
          state.target = expression.includes("document.querySelector('.sb-new')") ? 'new'
            : state.phase !== 'before' && expression.includes("textContent.includes('cache-b')") ? 'b' : ''
          result = { x: 1, y: 1 }
        } else if ((state.phase === 'draft' && (expression.includes('document.getAnimations()') || expression === 'window.structureEntries = []'))
          || (state.phase === 'b' && expression === entryCount)) {
          result = runInNewContext(expression, { document, window })
        }
        if (state.phase === 'draft') {
          state.reads++
          if (state.reads === 2) {
            state.draft = true
            state.animating = true
            window.structureEntries.push({ id: 'scry-structure' })
          } else if (state.reads === 3) {
            state.animating = false
          }
        }
        return result
      },
      sendInputEvent: ({ type }: { type: string }) => {
        if (type !== 'mouseUp') return
        if (state.target === 'new') {
          selectionOrder.push('new')
          state.phase = 'draft'
        } else if (state.target === 'b') {
          selectionOrder.push('b')
          state.phase = 'b'
          window.structureEntries.push({ id: 'scry-structure' })
        }
      },
      insertText: async () => {},
      debugger: { sendCommand: async () => {} }
    }
    const result = await exerciseStructure(contents)
    expect(result.newConversationResetsIdentity).toBe(true)
    expect(selectionOrder).toEqual(['new', 'b'])
    expect(window.structureEntries).toHaveLength(1)
  })
})
