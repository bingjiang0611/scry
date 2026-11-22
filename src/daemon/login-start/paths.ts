import { dirname, isAbsolute, join, resolve } from 'node:path'
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, type ServiceTemplateInput } from '../supervisor-templates'


export interface LoginStartTarget {
  executable: string
  appPath: string
  resourcesPath: string
  userDataDir: string
  isPackaged: boolean
}

export interface LoginStartOverrides {
  isTestInstance: boolean
  testOverrideActive: boolean
  label: string
  unitName: string
  serviceDirOverride?: string
}

const SAFE_LABEL = /^[A-Za-z0-9._-]+$/
const SAFE_UNIT = /^[A-Za-z0-9._@-]+\.service$/

export function loginStartTemplateInput(
  target: LoginStartTarget,
  options: { policyEnv?: ReadonlyArray<readonly [string, string]>; label?: string } = {}
): ServiceTemplateInput {
  return {
    executable: target.executable,
    supervisorEntry: join(target.appPath, 'out', 'main', 'daemon-supervisor.js'),
    daemonEntry: join(target.appPath, 'out', 'main', 'daemon.js'),
    userDataDir: target.userDataDir,
    appPath: target.appPath,
    resourcesPath: target.resourcesPath,
    isPackaged: target.isPackaged,
    ...(options.policyEnv && options.policyEnv.length > 0 ? { policyEnv: options.policyEnv } : {}),
    ...(options.label ? { label: options.label } : {})
  }
}

export function loginStartTargetFromBundle(
  executable: string,
  userDataDir: string,
  platform: NodeJS.Platform
): LoginStartTarget {
  const resourcesPath = platform === 'darwin'
    ? join(dirname(dirname(executable)), 'Resources')
    : join(dirname(executable), 'resources')
  return {
    executable,
    appPath: join(resourcesPath, 'app.asar'),
    resourcesPath,
    userDataDir,
    isPackaged: true
  }
}

export function isEphemeralMacAppPath(executable: string): boolean {
  const normalized = resolve(executable)
  return normalized.startsWith('/Volumes/') || normalized.includes('/AppTranslocation/')
}

export function resolveLoginStartOverrides(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): LoginStartOverrides {
  const isTestInstance = env.SCRY_TEST_APP === '1'
  if (!isTestInstance) {
    return {
      isTestInstance: false,
      testOverrideActive: false,
      label: LAUNCHD_LABEL,
      unitName: SYSTEMD_UNIT_NAME
    }
  }
  const dirRaw = env.SCRY_TEST_LOGIN_START_DIR?.trim()
  const serviceDirOverride = dirRaw ? resolve(dirRaw) : undefined
  if (platform === 'darwin') {
    const labelRaw = env.SCRY_TEST_LOGIN_START_LABEL?.trim()
    if (labelRaw && labelRaw !== LAUNCHD_LABEL && SAFE_LABEL.test(labelRaw)) {
      return {
        isTestInstance: true,
        testOverrideActive: true,
        label: labelRaw,
        unitName: SYSTEMD_UNIT_NAME,
        ...(serviceDirOverride ? { serviceDirOverride } : {})
      }
    }
  } else if (platform === 'linux') {
    const unitRaw = env.SCRY_TEST_LOGIN_START_UNIT?.trim()
    if (unitRaw && unitRaw !== SYSTEMD_UNIT_NAME && SAFE_UNIT.test(unitRaw)) {
      return {
        isTestInstance: true,
        testOverrideActive: true,
        label: LAUNCHD_LABEL,
        unitName: unitRaw,
        ...(serviceDirOverride ? { serviceDirOverride } : {})
      }
    }
  }
  return {
    isTestInstance: true,
    testOverrideActive: false,
    label: LAUNCHD_LABEL,
    unitName: SYSTEMD_UNIT_NAME
  }
}

export function serviceFilePath(input: {
  platform: NodeJS.Platform
  homeDir: string
  xdgConfigHome?: string
  label: string
  unitName: string
  serviceDirOverride?: string
}): string {
  if (input.platform === 'darwin') {
    const dir = input.serviceDirOverride ?? join(input.homeDir, 'Library', 'LaunchAgents')
    return join(dir, `${input.label}.plist`)
  }
  const xdg = input.xdgConfigHome?.trim()
  const configBase = xdg && isAbsolute(xdg) ? xdg : join(input.homeDir, '.config')
  const dir = input.serviceDirOverride ?? join(configBase, 'systemd', 'user')
  return join(dir, input.unitName)
}
