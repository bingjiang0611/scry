import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeEnabledSkills, listSkills, setSkillEnabled } from './skill-config'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-skill-'))

function writeSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`)
}

describe('skill-config', () => {
  it('项目级 skillOverrides 存在时整体替代用户级 overrides', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      writeSkill(join(home, '.claude', 'skills'), 'user-off')
      writeSkill(join(cwd, '.claude', 'skills'), 'project-off')
      mkdirSync(join(home, '.claude'), { recursive: true })
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { 'user-off': 'off' } }))
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { 'project-off': 'off' } }))

      expect(listSkills(cwd, home)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'user-off', enabled: true }),
          expect.objectContaining({ name: 'project-off', enabled: false })
        ])
      )
      expect(computeEnabledSkills(cwd, home)).toEqual(['user-off'])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('开关 Skill 后重新读取返回持久化状态，并可恢复', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      writeSkill(join(cwd, '.claude', 'skills'), 'scry-e2e-audit')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ keep: 'value' }))

      setSkillEnabled('scry-e2e-audit', false, cwd, home)
      expect(listSkills(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e-audit', enabled: false }))
      expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.local.json'), 'utf8'))).toMatchObject({
        keep: 'value',
        skillOverrides: { 'scry-e2e-audit': 'off' }
      })

      setSkillEnabled('scry-e2e-audit', true, cwd, home)
      expect(listSkills(cwd, home)).toContainEqual(expect.objectContaining({ name: 'scry-e2e-audit', enabled: true }))
      expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.local.json'), 'utf8'))).toMatchObject({
        keep: 'value',
        skillOverrides: {}
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
