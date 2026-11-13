import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Which electron-security-smoke campaign `argv` selects, and whether it drives the dev
// layout or a packaged App. Split from electron-security-smoke.mjs by responsibility
// (argument modes vs. driving the App); the flags and their meanings are unchanged.
export function electronSecurityModes(argv) {
  const steerOnly = ['--dev-steer-only', '--steer-only'].includes(argv[2])
  const structureOnly = argv[2] === '--dev-structure-only'
  const sideChatOnly = argv[2] === '--dev-side-chat-only'
  const largeHistoryOnly = argv[2] === '--dev-side-chat-large-history-only'
  const sourceControlOnly = ['--dev-source-control-only', '--source-control-only'].includes(argv[2])
  const conversationOwnershipOnly = argv[2] === '--dev-conversation-ownership-only'
  const unifiedConversationOnly = argv[2] === '--dev-unified-conversation-only'
  const performanceOnly = ['--dev-performance-only', '--performance-only'].includes(argv[2])
  const nativeHistoryPerformanceOnly = argv[2] === '--dev-pi-history-perf-only'
  const nativeHistoryOnly = argv[2] === '--dev-pi-history-only' || nativeHistoryPerformanceOnly
  const fileHistoryOnly = ['--dev-file-history-only', '--file-history-only'].includes(argv[2])
  const sourceFileHistory = fileHistoryOnly ? JSON.parse(readFileSync(resolve(argv[3]), 'utf8')) : null
  const devMetaPromptsOnly = argv[2] === '--dev-meta-prompts-only'
  const devTerminalOnly = argv[2] === '--dev-terminal-only'
  const devQuestionOnly = argv[2] === '--dev-question-only'
  const foreground = argv.includes('--foreground')
  // Dock attention is cleared only by a genuinely focused native window.
  // Do not silently weaken that acceptance test or activate the app by default.
  if (devQuestionOnly && !foreground) {
    throw new Error('Dock attention requires native foreground focus; explicitly opt in with --dev-question-only --foreground')
  }
  const devFilesOnly = argv[2] === '--dev-files-only'
  const filesOnly = devFilesOnly || argv[2] === '--files-only'
  const devApp = argv[2] === '--dev-steer-only' || sideChatOnly || largeHistoryOnly || structureOnly || unifiedConversationOnly || conversationOwnershipOnly || argv[2] === '--dev-source-control-only' || devMetaPromptsOnly || nativeHistoryOnly || argv[2] === '--dev-file-history-only' || devTerminalOnly || devQuestionOnly || devFilesOnly || argv[2] === '--dev' || argv[2] === '--dev-performance-only'
  const packagedAppArgument = ['--steer-only', '--files-only', '--performance-only', '--file-history-only', '--source-control-only'].includes(argv[2]) ? undefined : argv[2]
  return { steerOnly, structureOnly, sideChatOnly, largeHistoryOnly, sourceControlOnly, conversationOwnershipOnly, unifiedConversationOnly, performanceOnly, nativeHistoryPerformanceOnly, nativeHistoryOnly, fileHistoryOnly, sourceFileHistory, devMetaPromptsOnly, devTerminalOnly, devQuestionOnly, foreground, devFilesOnly, filesOnly, devApp, packagedAppArgument }
}
