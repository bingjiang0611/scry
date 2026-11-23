import { expect, it } from 'vitest'
import { electronSecurityModes, electronSecurityTestEnvironment } from './electron-security-modes.mjs'

it('selects archived file replay without requiring an existing user archive', () => {
  expect(electronSecurityModes(['node', 'smoke', '--dev-file-history-only'])).toMatchObject({
    devApp: true, fileHistoryOnly: true, sourceFileHistory: null
  })
  expect(electronSecurityModes(['node', 'smoke', '--file-history-only'])).toMatchObject({
    devApp: false, fileHistoryOnly: true, sourceFileHistory: null
  })
})

it.each([
  ['--dev-unified-conversation-only', 'unifiedConversationOnly'],
  ['--dev-side-chat-only', 'sideChatOnly'],
  ['--dev-side-chat-large-history-only', 'largeHistoryOnly'],
  ['--dev-structure-only', 'structureOnly']
])('keeps the %s scenario when selected against a packaged layout', (flag, scenario) => {
  expect(electronSecurityModes(['node', 'smoke', flag, '--packaged'])).toMatchObject({
    devApp: false, instrumentedPackage: true, [scenario]: true
  })
})

it('keeps the foreground Dock smoke under the same test service and credential isolation', () => {
  expect(electronSecurityModes(['node', 'smoke', '--dev-question-only', '--foreground'])).toMatchObject({
    devQuestionOnly: true, foreground: true
  })
  const temp = '/private/tmp/scry-es-campaign'
  const env = electronSecurityTestEnvironment(temp)
  expect(env).toMatchObject({
    HOME: temp + '/home',
    SCRY_TEST_APP: '1',
    SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon.test.scry-es-campaign',
    SCRY_TEST_LOGIN_START_DIR: temp + '/home/LaunchAgents'
  })
})
