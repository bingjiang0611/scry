import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { isCodexInternalPrompt } from './recorder-hook-support'
import { listRecords } from './store'
import { payload, workspace } from './recorder-tests/fixture.test'

const instruction = 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. '
  + 'Start with an imperative verb. Capitalize only the first word unless the user\'s language, proper nouns, acronyms, '
  + 'or code terms require otherwise. Preserve ticket references exactly. Write in the user\'s language. '
  + 'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.'
const titleRequest = `${instruction}\n\nUser prompt:\n/rw REQ-1`

const healthOf = async (root: string) => JSON.parse(await readFile(join(root, '.scry', 'health.json'), 'utf8'))

describe('Codex internal prompts', () => {
  it('recognizes only the full title instruction paired with the captured-prompt separator', () => {
    expect(isCodexInternalPrompt({ prompt: titleRequest })).toBe(true)
    expect(isCodexInternalPrompt({ prompt: `  \n${titleRequest}` })).toBe(true)
    // Same opening words, ordinary request.
    expect(isCodexInternalPrompt({ prompt: 'Generate a concise, single-line task title for the roadmap' })).toBe(false)
    // Instruction alone, without a captured prompt.
    expect(isCodexInternalPrompt({ prompt: instruction })).toBe(false)
    // Instruction opening plus an inline mention, not the fixed separator.
    expect(isCodexInternalPrompt({ prompt: `${instruction} User prompt: /rw REQ-1` })).toBe(false)
    // Separator without the instruction's closing sentence.
    expect(isCodexInternalPrompt({ prompt: `Generate a concise, single-line task title of at most 36 characters\n\nUser prompt:\n/rw REQ-1` })).toBe(false)
  })

  it('ignores the title request and its paired terminal instead of recording or orphaning them', async () => {
    const root = await workspace()
    const started = await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('title-session', { prompt: titleRequest, turn_id: 'title-turn' })
    })
    expect(started).toMatchObject({ status: 'ignored', reason: 'codex internal title prompt' })
    const terminal = await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('title-session', { turn_id: 'title-turn', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    expect(terminal).toMatchObject({ status: 'ignored', reason: 'codex internal title turn' })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
    expect(await readdir(join(root, '.scry', 'runtime', 'codex', 'internal-turns'))).toEqual([])
    await expect(readdir(join(root, '.scry', 'orphans'))).rejects.toThrow(/ENOENT/)
    expect(await healthOf(root)).toMatchObject({ orphanEvents: 0, missingStartTerminals: 0 })
    expect((await healthOf(root)).lastError).toBeUndefined()
  })
})
