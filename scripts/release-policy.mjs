export function releaseBuildEnvironment({ releaseBuild, platform, env, discoveredIdentity }) {
  if (!releaseBuild || platform !== 'darwin') return { ...env }
  const next = { ...env }
  const identity = next.CSC_NAME || discoveredIdentity
  if (!next.CSC_LINK && !identity?.startsWith('Developer ID Application:')) {
    throw new Error('release build requires a Developer ID Application identity or CSC_LINK')
  }
  if (!next.SCRY_RELEASE_TEAM_ID && !next.APPLE_TEAM_ID) {
    throw new Error('release build requires SCRY_RELEASE_TEAM_ID or APPLE_TEAM_ID')
  }
  const hasNotaryCredentials = Boolean(
    (next.APPLE_API_KEY && next.APPLE_API_KEY_ID && next.APPLE_API_ISSUER) ||
    (next.APPLE_ID && next.APPLE_APP_SPECIFIC_PASSWORD && next.APPLE_TEAM_ID)
  )
  if (!hasNotaryCredentials) throw new Error('release build requires Apple notarization credentials')
  if (identity) next.CSC_NAME = identity
  return next
}
