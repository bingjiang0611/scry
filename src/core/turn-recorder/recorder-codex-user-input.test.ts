import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecorderContent } from './content-store'
import { handleRecorderHook } from './recorder'
import { parseCodexRollout } from './recorder-codex-rollout'
import { listRecords } from './store'
import { payload, workspace } from './recorder-tests/fixture.test'

const openPage = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'
// Sanitized native packets from the supplied Nov 10 (912–916) / Nov 3 (229–231) rollouts.
const selectedPage = '<external_codex_apps_selected_page_part_1_of_1>Companion Page snapshot part 1 of 1:\n{"page_id":null,"document_view":null}</external_codex_apps_selected_page_part_1_of_1>'
const nonEmptyPage = '<external_codex_apps_open_page>{"page_id":"<PAGE_ID>"}</external_codex_apps_open_page>'
const typedPrompt = '<TYPED_PROMPT>'
const pastedPrompt = '\n# Files mentioned by the user:\n\n## <PASTED_FILE_NAME>: <TMP_PATH>\n<TYPED_PROMPT>'
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
  row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<codex_apps_open_page_instructions>…</codex_apps_open_page_instructions>' }] }),
  row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<codex_apps_selected_page_instructions_0000>…</codex_apps_selected_page_instructions_0000>' }] }),
  user(selectedPage, 'selected-page'),
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

  it.each([
    [openPage, selectedPage, typedPrompt],
    [nonEmptyPage, pastedPrompt],
    ['<external_codex_apps_active_page>opaque payload</external_codex_apps_active_page>', typedPrompt],
    ['<external_codex_apps_open_page>{broken json}</external_codex_apps_open_page>', typedPrompt],
    ...[openPage, nonEmptyPage, selectedPage].map(packet => [typedPrompt, packet]),
    [...Array.from({ length: 3 }, (_, index) => {
      const name = `external_codex_apps_selected_page_part_${index + 1}_of_3`
      return `<${name}>Companion Page snapshot part ${index + 1} of 3:\n{"document_view":"<PAGE_BODY>"}</${name}>`
    }), typedPrompt]
  ])('excludes complete app packets from input and steering: %j', (...texts) => {
    const { turns } = parseCodexRollout(rollout(texts.map((text, i) => user(text, `message-${i}`))), 'packet-run')
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe(texts.includes(pastedPrompt) ? pastedPrompt : typedPrompt)
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it.each([openPage, nonEmptyPage, selectedPage])('does not let a canonical control packet suppress a legacy human message: %s', packet => {
    const { turns } = parseCodexRollout(rollout([
      user(packet, 'control'),
      row('event_msg', { type: 'user_message', message: 'Investigate the response.' })
    ]), 'legacy-input-run')
    expect(turns[0].userText).toBe('Investigate the response.')
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it('keeps control-only input empty without dropping its native turn or terminal', () => {
    const { turns } = parseCodexRollout(rollout([openPage, selectedPage, nonEmptyPage].map((packet, i) => user(` \n${packet}\n`, `control-${i}`))), 'control-only-run')
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe('')
    expect(turns[0].terminalStatus).toBe('completed')
    expect(turns[0].events.filter(event => event.kind === 'human')).toEqual([])
  })

  it.each([
    `Explain this packet: ${openPage}`,
    `${openPage}\nWhy does this appear?`,
    'Why does "<external_codex_apps_open_page>" appear here?',
    '<external_codex_apps_open_page>{}</external_codex_apps_selected_page_part_1_of_1>',
    '<external_codex_apps_open_page>{}',
    '<codex_apps_active_page>{}</codex_apps_active_page>',
    `${openPage}\n${openPage}`,
    `<external_codex_apps_open_page>{}</external_codex_apps_open_page>\n${typedPrompt}\n${openPage}`,
    `${selectedPage}\nPlease explain.`,
    `Please explain.\n${selectedPage}`,
    `Explain this skill declaration: ${skill}`,
    `${skill}\nIs this declaration correct?`,
    '<skill><name>team:first</name></skill>\nCompare these skills.\n<skill><name>team:second</name></skill>'
  ])('retains questions, mismatched markup and non-app prefixes: %s', text => {
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

  it.each([undefined, openPage, nonEmptyPage, selectedPage])('persists a context-only turn with unavailable human input (hook prompt: %s)', async prompt => {
    const root = await workspace()
    const path = join(root, 'context-only-rollout.jsonl')
    const content = rollout([openPage, selectedPage, nonEmptyPage].map((packet, i) => user(packet, `control-${i}`)))
    await writeFile(path, content)
    await handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('context-session', { ...(prompt ? { prompt } : {}), turn_id: 'input-turn', rollout_path: path })
    })
    await handleRecorderHook({
      provider: 'codex', event: 'turn/completed', workspace: root,
      payload: payload('context-session', { turn_id: 'input-turn', rollout_path: path, timestamp: completedAt })
    })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ providerTurnId: 'input-turn', status: 'completed', user: { status: 'unavailable' } })
    expect(records[0].user.value).toBeUndefined()
    expect(records[0].user.omissionReason).toBe('top-level user prompt was not observable')
    expect(await readFile(path, 'utf8')).toBe(content)
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
