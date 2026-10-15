import { describe, expect, it } from 'vitest'
import { githubRepositoryFromUrl } from './source-control'

describe('GitHub repository from real Git transport destinations', () => {
  it('recognizes the official SSH-over-443 endpoint used by this repository', () => {
    expect(githubRepositoryFromUrl('ssh://git@ssh.github.com:443/bingjiang0611/scry.git')).toBe('bingjiang0611/scry')
    expect(githubRepositoryFromUrl('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(githubRepositoryFromUrl('https://github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('does not guess GitHub identities from arbitrary hosts, aliases or credentials', () => {
    for (const url of ['ssh://git@alias:443/owner/repo.git', 'ssh://git@ssh.github.com:123/owner/repo.git', 'https://github.com.evil/owner/repo', 'https://token@github.com/owner/repo']) {
      expect(githubRepositoryFromUrl(url)).toBeNull()
    }
  })
})
