import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecorderContent } from './content-store'
import { handleRecorderHook } from './recorder'
import { parseCodexRollout } from './recorder-codex-rollout'
import { listRecords } from './store'
import { payload, workspace } from './recorder-tests/fixture.test'

const openPage = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'
const skillName = 'fixture-investigator:inspect'
const skill = `<skill>\n<name>${skillName}</name>\n<path>/fixture/SKILL.md</path>\nRead-only investigation.\n</skill>`
const question = `[$${skillName}](/fixture/SKILL.md)\nWhy is the progress bar missing?`
const followUp = 'Check the response before reading code.'
const startedAt = '2026-07-19T12:00:00.000Z'
const completedAt = '2026-07-19T12:00:01.000Z'
const row = (type: string, value: Record<string, unknown>, timestamp = startedAt) =>
  JSON.stringify({ type, payload: value, timestamp })
const user = (text: string, id: string) => row('response_item', {
  type: 'message', role: 'user', id, content: [{ type: 'input_text', text }]
})
const rollout = (inputs: string[]) => [
  row('event_msg', { type: 'task_started', turn_id: 'input-turn' }),
  ...inputs,
  row('event_msg', { type: 'task_complete', turn_id: 'input-turn', last_agent_message: 'Done.' }, completedAt)
].join('\n') + '\n'

const capturedShape = () => rollout([
  user(openPage, 'open-page'),
  user(question, 'question'),
  user(skill, 'skill'),
  user(openPage, 'open-page-again'),
  user(followUp, 'follow-up')
])

describe('Codex app controls and namespaced skill input', () => {
  it('selects the human question, records the skill, and keeps only genuine steering', () => {
    const { turns } = parseCodexRollout(capturedShape(), 'input-run')
    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn).toMatchObject({
      providerTurnId: 'input-turn', startedAt, completedAt, terminalStatus: 'completed',
      userText: `/${skillName} ${question}`
    })
    expect(turn.events.filter(event => event.kind === 'skill').map(event => event.name)).toEqual([skillName])
    expect(turn.observable.skills).toBe(true)
    expect(turn.events.filter(event => event.kind === 'human').map(event => event.steer)).toEqual([
      expect.objectContaining({ messageId: 'follow-up', prompt: followUp, status: 'accepted' })
    ])
  })

  it('does not let a canonical control packet suppress a legacy human message', () => {
    const { turns } = parseCodexRollout(rollout([
      user(openPage, 'control'),
      row('event_msg', { type: 'user_message', message: 'Investigate the response.' })
    ]), 'legacy-input-run')
    expect(turns[0].userText).toBe('Investigate the response.')
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it('keeps control-only input empty without dropping its native turn or terminal', () => {
    const { turns } = parseCodexRollout(rollout([user(` \n${openPage}\n`, 'control')]), 'control-only-run')
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe('')
    expect(turns[0].terminalStatus).toBe('completed')
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it.each([
    `Explain this packet: ${openPage}`,
    `${openPage}\nWhy does this appear?`,
    '<external_codex_apps_open_page>{"page_id":"unverified-shape"}</external_codex_apps_open_page>',
    '<external_codex_apps_open_page>{broken json}</external_codex_apps_open_page>',
    `Explain this skill declaration: ${skill}`,
    `${skill}\nIs this declaration correct?`
  ])('retains ordinary questions, quoted markup and unverified packet shapes: %s', text => {
    const { turns } = parseCodexRollout(rollout([user(text, 'question')]), 'ordinary-input-run')
    expect(turns[0].userText).toBe(text)
    expect(turns[0].events.filter(event => event.kind === 'skill')).toEqual([])
  })

  it.each(['fixture-skill', skillName])('recognizes a complete %s skill injection without canonical conversation input', name => {
    const { turns } = parseCodexRollout(rollout([
      user(`<skill><name>${name}</name></skill>`, 'skill'),
      row('event_msg', { type: 'user_message', message: 'Investigate.' })
    ]), 'skill-input-run')
    expect(turns[0].userText).toBe(`/${name} Investigate.`)
    expect(turns[0].events.filter(event => event.kind === 'skill').map(event => event.name)).toEqual([name])
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it('persists the corrected input and skill while retaining raw transcript evidence', async () => {
    const root = await workspace()
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.capture.toolOutput = 'full'
    await writeFile(configPath, JSON.stringify(config))
    const path = join(root, 'input-rollout.jsonl')
    const content = capturedShape()
    await writeFile(path, content)
    await handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('input-session', { prompt: openPage, turn_id: 'input-turn', rollout_path: path })
    })
    await handleRecorderHook({
      provider: 'codex', event: 'turn/completed', workspace: root,
      payload: payload('input-session', { turn_id: 'input-turn', rollout_path: path, timestamp: completedAt })
    })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record).toMatchObject({ sessionId: 'input-session', providerTurnId: 'input-turn', startedAt, completedAt })
    expect(record.user.value?.text).toBe(`/${skillName} ${question}`)
    expect(record.user.value?.steers?.map(steer => steer.prompt)).toEqual([followUp])
    expect(record.skills.value?.map(call => call.name)).toEqual([skillName])
    expect(record.transcript.status).toBe('available')
    expect(await readRecorderContent(join(root, '.scry'), record.transcript.value!.contentRef)).toBe(content)
    expect(await readFile(path, 'utf8')).toBe(content)
  })
})
