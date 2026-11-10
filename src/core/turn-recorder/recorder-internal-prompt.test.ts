import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { isCodexInternalPrompt } from './recorder-hook-support'
import { listRecords } from './store'
import { payload, workspace } from './recorder-tests/fixture.test'

const titleRequest = 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. '
  + 'Start with an imperative verb. Capitalize only the first word unless the user\'s language, proper nouns, acronyms, '
  + 'or code terms require otherwise. Preserve ticket references exactly. Write in the user\'s language. '
  + 'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\n\nUser prompt:\n/rw REQ-1'
const instructionOnly = titleRequest.slice(0, titleRequest.indexOf('\n\n\nUser prompt:'))

describe('Codex internal prompts', () => {
  it('recognizes only the title request that embeds a captured prompt', () => {
    expect(isCodexInternalPrompt({ prompt: titleRequest })).toBe(true)
    expect(isCodexInternalPrompt({ prompt: '  \n' + titleRequest })).toBe(true)
    expect(isCodexInternalPrompt({ prompt: 'Generate a concise, single-line task title for the roadmap' })).toBe(false)
    expect(isCodexInternalPrompt({ prompt: instructionOnly })).toBe(false)
  })

  it('does not open a turn for the Codex UI title request', async () => {
    const root = await workspace()
    const started = await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('title-session', { prompt: titleRequest, turn_id: 'title-turn' })
    })
    expect(started).toMatchObject({ status: 'ignored', reason: 'codex internal title prompt' })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('title-session', { turn_id: 'title-turn', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
  })
})
