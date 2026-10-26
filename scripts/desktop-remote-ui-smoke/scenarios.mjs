export const defaultScenarios = ['activity', 'workbench', 'runtime', 'hosts']

export function selectScenario(args) {
  const selected = args.find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length)
  if (selected !== undefined) {
    if (!defaultScenarios.includes(selected)) throw new Error(`Unknown DesktopRemote scenario: ${selected}`)
    return selected
  }
  // Existing focused/performance modes keep their original fixture and deadline.
  const focusedFlags = [
    '--unknown-receipt-only', '--remote-settings-only', '--session-parity-only',
    '--composer-history-only', '--session-lifecycle-only', '--conversation-navigation-only',
    '--session-opening-only', '--structure-only', '--measure-session-opening',
    '--visibility-polling-baseline', '--visibility-polling-check'
  ]
  return args.some(arg => focusedFlags.includes(arg)) ? 'focused' : null
}
