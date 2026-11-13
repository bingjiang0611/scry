import type { DaemonLockRecord } from '../../daemon/ledger-lock'
import { USERDATA_STOP_TIMEOUT_MS, type AppUserDataClaim } from './userdata-owner'

// Words for the userData ownership dialogs (userdata-owner.ts decides; this only names the
// decision). Free of Electron so the copy is checked next to the reasons it explains.

export const STOP_DAEMON_BUTTON = 0
export const QUIT_BUTTON = 1

export interface OwnerPrompt {
  type: 'warning' | 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

export function stopDaemonPrompt(holder: DaemonLockRecord): OwnerPrompt {
  return {
    type: 'warning',
    title: 'Scry 后台服务仍在运行',
    message: '后台服务仍在使用这个数据目录',
    detail: [
      `之前以后台服务模式（SCRY_HOST_DAEMON=1）运行时启动的后台服务（进程 ${holder.pid}）仍在运行，并在写入这个数据目录。`,
      '两个进程同时写入会损坏会话、用量和数据库记录，所以它运行期间 Scry 不会启动。',
      '停止后台服务会中断它正在执行的任务和已配对设备的连接。'
    ].join('\n\n'),
    buttons: ['停止后台服务', '退出'],
    defaultId: QUIT_BUTTON,
    cancelId: QUIT_BUTTON
  }
}

const NOTHING_WRITTEN = 'Scry 没有写入这个数据目录，现在退出。'

/** The explanation shown before a fail-closed quit; undefined when the user chose to quit. */
export function quitNotice(claim: Extract<AppUserDataClaim, { status: 'quit' }>, stopTimeoutMs = USERDATA_STOP_TIMEOUT_MS): OwnerPrompt | undefined {
  const pid = claim.holder?.pid
  const who = pid === undefined ? '占用者' : `进程 ${pid}`
  let detail: string
  switch (claim.reason) {
    case 'user-quit':
      return undefined
    case 'holder-unverifiable':
      detail = `无法确认占用数据目录的${who}是否仍在运行（锁记录的身份格式无法比较）。请确认它已退出后再打开 Scry。`
      break
    case 'holder-not-daemon':
      detail = `另一个 Scry 进程（${who}）正在使用这个数据目录。请先关闭它，再打开 Scry。`
      break
    case 'identity-changed':
      detail = `${who}已不是你确认要停止的后台服务（进程号可能已被其他程序复用），Scry 没有向它发送停止信号。请重新打开 Scry。`
      break
    case 'identity-unreadable':
      detail = `无法读取${who}的身份，不能确认它就是后台服务，Scry 没有向它发送停止信号。请重新打开 Scry。`
      break
    case 'identity-unrecorded':
      detail = `锁记录没有${who}的身份信息，不能安全地停止它。请确认它已退出后再打开 Scry。`
      break
    case 'lock-changed':
      detail = '在你确认之后，数据目录换了占用者，Scry 没有发送停止信号。请重新打开 Scry。'
      break
    case 'stop-timeout':
      detail = `已请求后台服务（${who}）停止，但它在 ${Math.round(stopTimeoutMs / 1000)} 秒内没有退出。Scry 没有再次发送信号。请稍后重新打开 Scry。`
      break
    case 'signal-failed':
      detail = `无法向后台服务（${who}）发送停止信号。请手动结束它后再打开 Scry。`
      break
    case 'owned-after-stop':
      detail = `后台服务停止后，数据目录立即又被${who}占用（可能是后台服务的监护进程又启动了它）。请重新打开 Scry。`
      break
    case 'lock-error':
      detail = '无法读写数据目录锁（scry-userdata.lock）或读取本进程身份，无法确认没有其他进程在写入。'
      break
  }
  return {
    type: 'error',
    title: 'Scry 无法启动',
    message: '另一个进程可能正在写入这个数据目录',
    detail: `${detail}\n\n${NOTHING_WRITTEN}`,
    buttons: ['退出'],
    defaultId: 0,
    cancelId: 0
  }
}
