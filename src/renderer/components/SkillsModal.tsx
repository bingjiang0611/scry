import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { SkillMeta } from '../env'

import type { CapabilityEnvelope } from '@shared/provider'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY, LOADING_COPY } from '../constants/copy'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { useFirstReadyList } from '../hooks/useFirstReadyList'
import { DelayedLoadingStatus } from './LoadingStatus'


import './archived-sessions.css'



import { ModalFrame, requestModalClose } from './ModalFrame'

import { EvidenceState, InventoryContext, filterSkillsForScope, scopeClass, scopeShortLabel, useReadStarted, type SkillScopeFilter } from './CapabilityEvidence'
export { filterSkillsForScope } from './CapabilityEvidence'

export function SkillsModal({
  skills,
  capability,
  refreshing = false,
  onRefresh,
  onClose
}: {
  skills: SkillMeta[]
  capability?: CapabilityEnvelope<SkillMeta[]> | null
  refreshing?: boolean
  onRefresh: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const initialScope: SkillScopeFilter = skills.some((skill) => skill.scope === 'project')
    ? 'project'
    : skills.some((skill) => skill.scope === 'user')
      ? 'user'
      : skills.length > 0
        ? 'provider'
        : 'project'
  const [scope, setScope] = useState<SkillScopeFilter>(initialScope)
  const scopeChosenRef = useRef(false)
  const [query, setQuery] = useState('')
  const scopeSkills = filterSkillsForScope(skills, scope)
  const filtered = filterSkillsForScope(skills, scope, query)
  // Null evidence is not an empty result, even before the read effect starts.
  const initialSkillsLoading = (refreshing || capability === null) && skills.length === 0
  const readStarted = useReadStarted(refreshing)
  const skillsUnavailable = capability === null && !refreshing && readStarted
  const showSkillsLoading = useDelayedFlag(refreshing)
  const listMotion = useFirstReadyList(filtered.length > 0)
  const projectCount = skills.filter((skill) => skill.scope === 'project').length
  const userCount = skills.filter((skill) => skill.scope === 'user').length
  const providerCount = skills.length - projectCount - userCount
  const scopeLabel = LOADING_COPY.skillScope[scope]
  const visibleScopes: SkillScopeFilter[] = providerCount > 0
    ? ['project', 'user', 'provider']
    : ['project', 'user']
  useEffect(() => {
    if (!visibleScopes.includes(scope)) {
      setScope(projectCount > 0 ? 'project' : 'user')
      return
    }
    if (scopeChosenRef.current || skills.length === 0 || filterSkillsForScope(skills, scope).length > 0) return
    setScope(projectCount > 0 ? 'project' : userCount > 0 ? 'user' : 'provider')
  }, [projectCount, providerCount, scope, skills, userCount])
  const chooseScope = (next: SkillScopeFilter): void => {
    scopeChosenRef.current = true
    setScope(next)
  }
  const onScopeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = visibleScopes.indexOf(scope)
    const next = event.key === 'Home'
      ? visibleScopes[0]
      : event.key === 'End'
        ? visibleScopes.at(-1)
        : event.key === 'ArrowRight'
          ? visibleScopes[(current + 1) % visibleScopes.length]
          : event.key === 'ArrowLeft'
            ? visibleScopes[(current - 1 + visibleScopes.length) % visibleScopes.length]
            : undefined
    if (!next) return
    event.preventDefault()
    chooseScope(next)
    window.requestAnimationFrame(() => document.getElementById(`${titleId}-${next}-tab`)?.focus())
  }
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={searchRef} className="skills-modal inventory-modal inventory-modal--skills" onClose={onClose}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability inventory</span>
          <div className="inventory-modal__title-line">
            <b id={titleId}>Skills</b>
            {capability?.providerId && <span className="inventory-provider">{capability.providerId}</span>}
          </div>
          <p>查看当前 Provider 在这个工作目录里实际发现了哪些 Skill。</p>
        </div>
        <div className="inventory-modal__head-actions">
          {showSkillsLoading && <EvidenceState value={{ state: 'pending', label: LOADING_COPY.reading, role: 'status' }} quiet />}
          <button className="modal-refresh" onClick={onRefresh} disabled={refreshing} title="重新读取当前 Provider 的 Skill 清单" aria-label="刷新 Skills">
            <Icon name="refresh" />
          </button>
          <ModalCloseButton onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeSkills} />
        </div>
      </div>

      <InventoryContext
        capability={capability}
        kind="Skills"
        summary={initialSkillsLoading ? '' : LOADING_COPY.skillsResults(filtered.length)}
      />

      {capability && capability.state !== 'ready' && (
        <div className="inventory-capability-note" role={capability.state === 'unknown' ? 'alert' : 'status'}>
          {capability.reason ?? capability.state}
        </div>
      )}

      <div className="skill-scope-tabs" role="tablist" aria-label="Skill 来源">
        <button
          type="button"
          id={titleId + '-project-tab'}
          role="tab"
          tabIndex={scope === 'project' ? 0 : -1}
          aria-selected={scope === 'project'}
          aria-controls={titleId + '-skills-panel'}
          className={scope === 'project' ? 'active' : ''}
          onClick={() => chooseScope('project')}
          onKeyDown={onScopeKeyDown}
        >
          {LOADING_COPY.skillScope.project} {!initialSkillsLoading && <span>{projectCount}</span>}
        </button>
        <button
          type="button"
          id={titleId + '-user-tab'}
          role="tab"
          tabIndex={scope === 'user' ? 0 : -1}
          aria-selected={scope === 'user'}
          aria-controls={titleId + '-skills-panel'}
          className={scope === 'user' ? 'active' : ''}
          onClick={() => chooseScope('user')}
          onKeyDown={onScopeKeyDown}
        >
          {LOADING_COPY.skillScope.user} {!initialSkillsLoading && <span>{userCount}</span>}
        </button>
        {providerCount > 0 && (
          <button
            type="button"
            id={titleId + '-provider-tab'}
            role="tab"
            tabIndex={scope === 'provider' ? 0 : -1}
            aria-selected={scope === 'provider'}
            aria-controls={titleId + '-skills-panel'}
            className={scope === 'provider' ? 'active' : ''}
            onClick={() => chooseScope('provider')}
            onKeyDown={onScopeKeyDown}
          >
            {LOADING_COPY.skillScope.provider} <span>{providerCount}</span>
          </button>
        )}
      </div>

      <div className="inventory-toolbar">
        <label className="inventory-search">
          <span>搜索</span>
          <input
            ref={searchRef}
            type="search"
            className="modal-search"
            placeholder={`搜索${scopeLabel}`}
            aria-label="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清除</button>}
        </label>
        {!initialSkillsLoading && <span className="inventory-toolbar__count" aria-live="polite">{LOADING_COPY.skillsVisible(filtered.length, scopeSkills.length)}</span>}
      </div>

      <div
        className="modal-body inventory-modal__body"
        id={titleId + '-skills-panel'}
        role="tabpanel"
        aria-labelledby={titleId + '-' + scope + '-tab'}
        aria-busy={refreshing}
      >
        {skillsUnavailable ? <div className="inventory-empty" role="status">{LOADING_COPY.skillsUnavailable}</div>
          : initialSkillsLoading && <DelayedLoadingStatus loading={refreshing} title={LOADING_COPY.skills} />}
        {filtered.length === 0 && !initialSkillsLoading && (
          <div className="inventory-empty" role="status">
            <strong>{scopeSkills.length === 0 ? LOADING_COPY.skillsEmpty(scopeLabel) : LOADING_COPY.skillsNoMatch(scopeLabel)}</strong>
            <p>{scopeSkills.length === 0 ? `当前 Provider 没有返回${scopeLabel}。` : '换一个关键词，或清空搜索查看全部条目。'}</p>
            {query && <button type="button" onClick={() => setQuery('')}>清空搜索</button>}
          </div>
        )}

        {filtered.length > 0 && (
          <div className={`skill-ledger ${listMotion.className}`}>
            {filtered.map((skill, index) => (
              <article className="skill-ledger__row motion-stagger-item" style={listMotion.itemStyle(index)} key={skill.scope + ':' + skill.name}>
                <div className="skill-ledger__main">
                  <div className="skill-ledger__name-line">
                    <strong>{skill.name}</strong>
                    <span className={'inventory-scope inventory-scope--' + scopeClass(skill.scope)}>{scopeShortLabel(skill.scope)}</span>
                  </div>
                  <p title={skill.description}>{skill.description}</p>
                  <div className="skill-ledger__source"><span>来源</span><code title={skill.dir}>{skill.dir}</code></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>发现证据</span>
        <p>清单直接来自当前 Provider 在这个工作目录的发现结果，Scry 只读取、不改写 Skill 配置。</p>
      </div>
    </ModalFrame>
  )
}
