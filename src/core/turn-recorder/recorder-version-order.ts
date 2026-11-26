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
  return comparePrerelease(left.prerelease, right.prerelease) > 0
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1
    if (b[index] === undefined) return 1
    const numeric = /^\d+$/.test(a[index]) && /^\d+$/.test(b[index])
    if (numeric) {
      const difference = Number(a[index]) - Number(b[index])
      if (difference !== 0) return difference
      continue
    }
    if (/^\d+$/.test(a[index])) return -1
    if (/^\d+$/.test(b[index])) return 1
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}