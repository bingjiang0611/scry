import { describe, expect, it } from 'vitest'
import { sessionPreviewPage } from './session-preview'

describe('sessionPreviewPage', () => {
  it('publishes the catalog prompt as incomplete display-only history', () => {
    expect(sessionPreviewPage('session-1', '  latest prompt  ', 'run-1')).toEqual({
      turns: [{ runId: 'run-1', userText: 'latest prompt', items: [], done: true }],
      offset: 0,
      totalTurns: 1,
      hasOlder: false,
      sourceComplete: false,
      completeness: 'partial'
    })
  })

  it('does not invent a turn without a catalog preview', () => {
    expect(sessionPreviewPage('session-1', '  ')).toBeUndefined()
  })
})
