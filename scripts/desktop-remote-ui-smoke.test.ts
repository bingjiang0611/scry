import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { defaultScenarios, selectScenario } from './desktop-remote-ui-smoke/scenarios.mjs'

const directory = resolve('scripts/desktop-remote-ui-smoke')
const files = readdirSync(directory).filter(name => name.endsWith('.mjs')).map(name => resolve(directory, name))

function unboundNames(removeCheck = false): string[] {
  const options: ts.CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, skipLibCheck: true, lib: ['lib.es2022.d.ts'], types: ['node']
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (removeCheck && file === resolve(directory, 'initial-controls.mjs')) {
      return ts.createSourceFile(file, readFileSync(file, 'utf8').replace('click, wait, check, fixture', 'click, wait, fixture'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    }
    return getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  }
  return ts.createProgram(files, options, host).getSemanticDiagnostics()
    .filter(diagnostic => diagnostic.code === 2304 || diagnostic.code === 2552)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
}

describe('DesktopRemote UI scenario organization', () => {
  it('runs all four independent responsibilities by default, including mutation runs', () => {
    expect(defaultScenarios).toEqual(['activity', 'workbench', 'runtime', 'hosts'])
    expect(selectScenario([])).toBeNull()
    expect(selectScenario(['--negative-workspace-control'])).toBeNull()
  })

  it.each(defaultScenarios)('selects the isolated %s scenario', scenario => {
    expect(selectScenario(['--scenario=' + scenario])).toBe(scenario)
  })

  it.each([
    '--unknown-receipt-only', '--remote-settings-only', '--session-parity-only',
    '--composer-history-only', '--session-lifecycle-only', '--conversation-navigation-only',
    '--session-opening-only', '--structure-only', '--measure-session-opening',
    '--visibility-polling-baseline', '--visibility-polling-check'
  ])('retains focused mode %s', flag => {
    expect(selectScenario([flag, '--negative-unknown-receipt-control'])).toBe('focused')
  })

  it('rejects a misspelled scenario instead of silently passing without running it', () => {
    expect(() => selectScenario(['--scenario=workbenhc'])).toThrow('Unknown DesktopRemote scenario')
  })

  it('has no hidden bindings left over from the former monolithic function', () => {
    expect(unboundNames()).toEqual([])
    expect(unboundNames(true)).toContain("Cannot find name 'check'.")
  })
})
