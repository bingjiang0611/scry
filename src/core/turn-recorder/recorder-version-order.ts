const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parts(version: string): { numbers: number[]; prerelease: string | null } | null {
  const match = PATTERN.exec(version.trim())
  if (!match) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null }
}

export function isNewerRecorderVersion(candidate: string | undefined, reference: string): boolean {
  if (!candidate) return false
  const left = parts(candidate)
  const right = parts(reference)
  if (!left || !right) return false
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index]
  }
  if (left.prerelease === right.prerelease) return false
  if (left.prerelease === null) return true
  if (right.prerelease === null) return false
  return left.prerelease > right.prerelease
}