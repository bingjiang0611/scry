import { detectStrippedAntigravityEnvNames } from '../provider-environment'

export function formatAntigravityUnauthenticatedError(rawEnv: Record<string, string | undefined>): string {
  const base = 'Antigravity 未登录：在终端运行 agy 完成登录（或 agy acp --login），再回到 Scry 刷新'
  const stripped = detectStrippedAntigravityEnvNames(rawEnv)
  if (stripped.length === 0) return base
  return `${base}（检测到已清洗的环境变量：${stripped.join(', ')}；如需使用请配置 SCRY_PROVIDER_ENV_ALLOW=antigravity:<NAME>）`
}
