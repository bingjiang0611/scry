import { describe, expect, it } from 'vitest'
import { agentPermissionQuestion } from './runtime-input'
import type { AgentQuestionRequest } from './runtime-types'
import { isIntervention } from './turn-intervention-validation'

// Round six F0: a Qoder Bash approval used the 129-char command as `header`, the record contract
// caps it at 120, and the managed commit failed with `$.interventions invalid intervention evidence`.
const command = `git add e4.txt && git commit -m "$(cat <<'EOF'\nAdd e4.txt with hello\n\nA longer commit body that pushes this title well past the cap.\nEOF\n)"`

function answered(request: AgentQuestionRequest) {
  const question = request.questions[0].question
  return {
    kind: 'permission', source: request.source, resolution: 'answered', request,
    response: { runId: request.runId, questionId: request.questionId, behavior: 'answered', answers: { [question]: '允许一次' } },
    openedAt: '2026-11-12T12:00:00.000Z', closedAt: '2026-11-12T12:00:02.000Z', durationMs: 2000
  }
}

describe('permission questions stay within the persisted intervention contract', () => {
  it('clips a long Provider title for the header and keeps it whole in the allow-once option', () => {
    expect(command.length).toBeGreaterThan(120)
    const request = agentPermissionQuestion('run-1', 'tool-1', command, '允许 Bash 执行这项操作吗？', 'Run a shell command', false, 'qoder:permission:Bash')
    const [prompt] = request.questions
    expect(prompt.header).toHaveLength(120)
    expect(prompt.header.endsWith('…')).toBe(true)
    expect(prompt.options[0].description).toBe(`${command}\n\nRun a shell command`)
    expect(isIntervention(answered(request))).toBe(true)
  })

  it('negative control: the same title used unclipped is rejected by the record validator', () => {
    const request = agentPermissionQuestion('run-1', 'tool-1', '权限请求', '允许 Bash 执行这项操作吗？', 'Run a shell command', false)
    request.questions[0].header = command
    expect(isIntervention(answered(request))).toBe(false)
  })

  it('leaves short titles and descriptions unchanged, and never persists an empty description or header', () => {
    const short = agentPermissionQuestion('run-1', 'tool-1', 'Edit e4.txt', '允许 Write 执行这项操作吗？', 'Writes a file')
    expect(short.questions[0].header).toBe('Edit e4.txt')
    expect(short.questions[0].options[0].description).toBe('Writes a file')
    const empty = agentPermissionQuestion('run-1', 'tool-2', '  ', '允许 Write 执行这项操作吗？', '')
    expect(empty.questions[0].header).toBe('权限请求')
    expect(empty.questions[0].options[0].description).toBe('Provider 未提供操作说明')
    expect(isIntervention(answered(empty))).toBe(true)
  })

  it('clips an oversized description and does not split a surrogate pair', () => {
    const request = agentPermissionQuestion('run-1', 'tool-1', `${'a'.repeat(118)}😀tail`, '允许吗？', 'x'.repeat(5_000))
    expect(request.questions[0].header).toBe(`${'a'.repeat(118)}…`)
    expect(request.questions[0].options[0].description.length).toBeLessThanOrEqual(4_000)
    expect(isIntervention(answered(request))).toBe(true)
  })
})
