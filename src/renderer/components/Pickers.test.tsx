import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DetectedAgent } from '../env'
import { CliPicker } from './Pickers'

const detected: DetectedAgent = {
  id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: '/runtime/rotom', version: '0.1.26'
}
const saved: DetectedAgent = { ...detected, id: 'pi:564f7a994e4e34da' }

function picker(agents: DetectedAgent[], selectedId = detected.id): string {
  return renderToStaticMarkup(<CliPicker agents={agents} selectedId={selectedId} onSelect={() => {}} onRemovePi={() => {}} open />)
}

function choices(markup: string): string[] {
  return [...markup.matchAll(/class="mitem agent-option-pick" data-agent-id="([^"]+)"/g)].map((match) => match[1])
}

describe('Pi picker launcher aliases', () => {
  it('shows only the detected entry for a shared launcher, regardless of catalog order', () => {
    for (const agents of [[detected, saved], [saved, detected]]) {
      const markup = picker(agents)
      expect(choices(markup)).toEqual([detected.id])
      expect(markup).toContain('系统检测 · 0.1.26')
      expect(markup).not.toContain('agent-option-remove')
      expect(agents).toHaveLength(2)
    }
  })

  it('preserves the selected historical identity instead of switching its session', () => {
    const markup = picker([detected, saved], saved.id)
    expect(choices(markup)).toEqual([saved.id])
    expect(markup).toContain('自定义 Profile · 0.1.26')
    expect(markup).toContain('agent-option-remove')
    expect(markup).toContain('当前')
  })

  it('keeps same-name/version profiles that launch different executables', () => {
    expect(choices(picker([detected, { ...saved, path: '/another/rotom' }]))).toEqual([detected.id, saved.id])
  })

  it('retains saved profiles when the launcher is no longer detected', () => {
    expect(choices(picker([saved], saved.id))).toEqual([saved.id])
  })

  it('does not treat remote host labels as launcher identity', () => {
    const remoteDefault = { ...detected, id: 'pi', path: 'Host · pi' }
    const remoteProfile = { ...saved, id: 'pi:pi:564f7a994e4e34da', path: 'Host · pi' }
    expect(choices(picker([remoteDefault, remoteProfile], remoteDefault.id))).toEqual([remoteDefault.id, remoteProfile.id])
  })

  it('collapses aliases while a different Provider is selected', () => {
    const claude: DetectedAgent = { id: 'claude', name: 'Claude', bin: 'claude', path: '/bin/claude' }
    expect(choices(picker([claude, detected, saved], claude.id))).toEqual([detected.id])
  })
})
