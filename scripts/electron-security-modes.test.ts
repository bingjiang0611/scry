import { expect, it } from 'vitest'
import { electronSecurityModes, electronSecurityTestEnvironment } from './electron-security-modes.mjs'

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
