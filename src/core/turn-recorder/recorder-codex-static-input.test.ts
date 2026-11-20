import { describe, expect, it } from 'vitest'
import { normalizedCodexCalls } from './recorder-codex-calls.js'

function input(argument: string) {
  const source = 'await tools.exec_command(' + argument + ')'
  const [call] = normalizedCodexCalls({ name: 'exec', input: source })
  expect(call.input.execSource).toBe(source)
  return call.input
}

describe('Bash arguments inside native exec scripts', () => {
  it('keeps JSON input structured', () => {
    expect(input('{"cmd":"pwd"}')).toMatchObject({ cmd: 'pwd', command: 'pwd' })
  })
  it('records simple JavaScript literals without evaluating the program', () => {
    expect(input('{cmd:"pwd"}')).toMatchObject({ raw: '{cmd:"pwd"}', command: 'pwd' })
    expect(input("{cmd: 'pwd', workdir: '/tmp', yield_time_ms: 20,}")).toMatchObject({
      command: 'pwd', cwd: '/tmp', yieldTimeMs: 20
    })
  })
  it.each(['options', '{cmd: getCommand()}', '{cmd: "pwd", ...opts}', '{cmd: "p" + "wd"}',
    '{cmd: "pwd", cmd: other}', '{cmd: "pwd", workdir: cwd}'])('keeps %s unresolved', argument => {
    const actual = input(argument)
    expect(actual).toMatchObject({ raw: argument, commandUnresolved: true })
    expect(actual).not.toHaveProperty('command')
  })
})
