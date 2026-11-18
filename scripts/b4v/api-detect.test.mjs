import { describe, expect, it } from 'vitest'
import { callExpression, findAction, functionPaths, genericChannelLeaks, surfaceDifference } from './api-detect.mjs'

const tree = {
  start: 'function',
  rendererRestart: 'function',
  conversations: { send: 'function', fork: 'function' },
  desktopRemote: { connect: 'function' },
  runTraces: { subscribe: 'function' },
  version: 'string'
}

describe('b4v preload surface detection', () => {
  it('flattens the preload tree to function paths', () => {
    expect(functionPaths(tree)).toEqual(['conversations.fork', 'conversations.send', 'desktopRemote.connect', 'rendererRestart', 'runTraces.subscribe', 'start'])
  })

  it('does not mistake the window restart for the background-service restart', () => {
    expect(findAction(functionPaths(tree), 'restart-daemon')).toEqual({ status: 'absent' })
    expect(findAction([...functionPaths(tree), 'daemon.restart'], 'restart-daemon')).toEqual({ status: 'found', path: 'daemon.restart', by: 'name' })
    expect(findAction(['restartBackgroundService', 'quitWithBackgroundService'], 'quit-all')).toMatchObject({ status: 'found', path: 'quitWithBackgroundService' })
  })

  it('refuses to guess between candidates; an explicit path decides', () => {
    const paths = ['daemon.restart', 'restartDaemonService']
    expect(findAction(paths, 'restart-daemon')).toEqual({ status: 'ambiguous', candidates: paths })
    expect(findAction(paths, 'restart-daemon', 'daemon.restart')).toMatchObject({ status: 'found', by: 'override' })
    expect(findAction(paths, 'restart-daemon', 'daemon.nope')).toMatchObject({ status: 'absent' })
  })

  it('only calls identifier paths', () => {
    expect(callExpression('daemon.restart')).toContain('window.scry.daemon.restart()')
    expect(() => callExpression('daemon["x"]')).toThrow(/non-identifier/)
    expect(() => callExpression('a;alert(1)')).toThrow(/non-identifier/)
  })

  it('flags generic channel leaves, allowing typed namespaced verbs', () => {
    expect(genericChannelLeaks(functionPaths(tree))).toEqual([])
    expect(genericChannelLeaks(['invoke', 'send', 'x.ipcRenderer', 'daemon.localOp', 'conversations.send'])).toEqual(['invoke', 'send', 'x.ipcRenderer', 'daemon.localOp'])
  })

  it('reports surface differences between the daemon App and the control', () => {
    expect(surfaceDifference(['a', 'b'], ['a', 'c'])).toEqual({ onlyInDaemon: ['b'], onlyInControl: ['c'] })
  })
})
