import { dialog } from 'electron'
import { claimAppUserData, type AppUserDataClaim } from './userdata-owner'
import { quitNotice, STOP_DAEMON_BUTTON, stopDaemonPrompt } from './userdata-owner-messages'

// Electron side of the switch-off App's userData claim: the two message boxes. There is
// no window yet (the claim runs before createWindow), so the boxes are app-modal.
export async function claimAppUserDataWithDialog(userDataDir: string): Promise<AppUserDataClaim> {
  const claim = await claimAppUserData({
    userDataDir,
    ask: async (holder) => {
      const { response } = await dialog.showMessageBox(stopDaemonPrompt(holder))
      return response === STOP_DAEMON_BUTTON ? 'stop' : 'quit'
    }
  })
  if (claim.status === 'quit') {
    const notice = quitNotice(claim)
    if (notice) await dialog.showMessageBox(notice)
  }
  return claim
}
