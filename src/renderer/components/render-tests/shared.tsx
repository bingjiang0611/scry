import { describe, it, expect, vi } from 'vitest'
import { attachmentsAfterSuccessfulSubmit } from "../../composer-drafts"
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef, type ComponentProps } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest } from '@shared/runtime'
import { sessionAttentionKey } from '@shared/session-attention'
import type { Turn } from "../../format"
import type { ParsedTurn, SessionHistoryPage } from "../../env"
import { App, EmptySessionOverview, MAX_SESSION_COMPOSER_DRAFTS, activeRunForSession, adoptLocalStartSessionId, attachmentsAfterFailedSubmit, appendWorkspaceReference, buildForkSessionRequest, applyNewConversationEffects, applyProviderCatalogRefresh, applySessionArchiveEffects, sessionEvidenceGapAfterLoad, applySessionCapturedEffects, applyTurnDoneEffects, commitDraftOnDispatch, dequeueStartedPrompt, enqueuePrompt, failedSlashCatalog, focusedRunNeedsLoading, hasSessionOverviewContext, inputAfterFailedSubmit, inputAfterSuccessfulSubmit, migrateSessionComposerDraft, migrateSessionPromptQueue, providerContextCacheKey, resetQueuedPromptControl, restoreActiveSessionSelection, restoreFocusedRunSelection, sessionComposerDraftKey, updateSessionComposerDraft, updateSessionPromptQueue, dequeueStartedPromptFromSessions, type QueuedPrompt, type SessionComposerDraft, type SessionEvidenceGap, scrollChatTargetIntoView, shouldQueuePrompt, shouldReloadProjectsForDataUpdate, nextDrainableQueuedPrompt } from "../../App"
import { chatBottomDistance, chatBottomStickinessAfterScroll, isChatNearBottom, scrollChatToBottomIfNeeded } from "../../chat-scroll"
import { resolveRunControlSelection, shouldResetRunControlCatalog } from "../../hooks/useIntegrations"
import { AssistantTurn, RecorderContentPager, UserMessage, attachmentSrc, coalesceAdjacentThinking } from "../ChatTurn"
import { WorkspaceFileLinkProvider } from "../MarkdownImpl"
import { ChatView, composerEnterConfirmsIme, composerPromptHistory, filterSlashCommands, formatElapsedMs, imageFilesFromClipboardData, navigateComposerHistory } from "../ChatView"
import { logicalCallEventsForTurn, overviewToolErrors, OverviewPanel, TurnFileFootprint, TurnToolErrorDetails, turnCallRowsFromMap } from "../OverviewPanel"
import { Sidebar } from "../Sidebar"
import { ViewChrome } from "../ViewChrome"
import { CliPicker, ModelEffortPicker, RunControlSelect } from "../Pickers"
import { pathContains, WorkspacePanel, workspaceReferenceToken } from "../WorkspacePanel"
import { parseUnifiedDiff, TurnDiffReviewPanel } from "../TurnDiffReviewPanel"
import { ArchivedChatsPanel, CapabilitiesModal, filterSkillsForScope, McpModal, SettingsModal, SkillsModal } from "../Modals"
import { AnalyticsView } from "../AnalyticsView"

const ev = (e: Partial<TraceEvent> & { id: string; kind: TraceEvent['kind']; stage: string }): TraceEvent => ({
  ts: '',
  runId: 'r1',
  ...e
})
const turn: Turn = {
  runId: 'r1',
  userText: '创建并读回文件',
  done: true,
  items: [
    ev({ id: 'e0', kind: 'model', stage: 'thinking', thinking: '\n\n' }),
    ev({ id: 'e1', kind: 'model', stage: 'thinking', thinking: '**先写文件再读回**\n\n' }),
    ev({ id: 'e2', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'cat /tmp/bash-only.txt' } }),
    ev({ id: 'e3', kind: 'tool', stage: 'tool:Write', tool: 'Write', fileOp: 'write', filePath: '/tmp/probe.txt', input: { content: 'hi\nthere' } }),
    ev({ id: 'e4', kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/tmp/probe.txt' }),
    ev({ id: 'e5', kind: 'model', stage: 'text', text: '完成' }),
    ev({
      id: 'e-hook',
      kind: 'hook',
      stage: 'hook_response',
      tool: 'PreToolUse:Edit',
      name: 'PreToolUse',
      hookName: 'PreToolUse:Edit',
      hookEvent: 'PreToolUse',
      hookCommand: '$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh',
      hookOutcome: 'success',
      hookExitCode: 0,
      input: { stdout: 'branch ok' },
      text: 'branch ok',
      output: 'branch ok'
    }),
    ev({
      id: 'e6',
      kind: 'harness',
      stage: 'result',
      costUsd: 0.1234,
      tokensIn: 1500,
      tokensOut: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 300,
      durationMs: 192400,
      durationApiMs: 5000,
      contextTokens: 87000,
      costSource: 'sdk_estimate',
      costConfidence: 'estimated',
      costUnit: 'usd',
      modelUsage: [
        {
          model: 'claude-opus-4-8',
          costUsd: 0.1234,
          costSource: 'sdk_estimate',
          costConfidence: 'estimated',
          costUnit: 'usd',
          contextWindow: 200000
        }
      ]
    })
  ]
}
const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)
const RUN_CONTROL_PROPS = {
  runControls: { permissionMode: 'default' as const },
  runControlCatalog: {
    models: [{
      model: { id: 'test-model' },
      label: 'Test Model',
      efforts: [{ id: 'high', label: '高' }]
    }, {
      model: { id: 'test-model-alias' },
      label: 'Test Model',
      efforts: []
    }],
    permissions: [
      { id: 'default' as const, label: '默认审批', description: '危险操作需要确认' },
      { id: 'full_access' as const, label: '完全访问', description: '跳过审批' }
    ]
  },
  onRunModel: () => {},
  onRunEffort: () => {},
  onPermissionMode: () => {}
}
const renderWelcome = (overrides: Partial<ComponentProps<typeof ChatView>> = {}): string => {
  const props: ComponentProps<typeof ChatView> = {
    turns: [],
    selectedId: null,
    scrollRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    cwd: null,
    recent: [],
    agents: [],
    selectedAgentId: 'claude',
    ...RUN_CONTROL_PROPS,
    input: '',
    busy: false,
    draftAttachments: [],
    queuedPrompts: [],
    slashOpen: false,
    slashLoading: false,
    slashCmds: [],
    slashSel: 0,
    onSelect: () => {},
    onInput: () => {},
    onChooseFolder: () => {},
    onPickRecent: () => {},
    onRemoveRecent: () => {},
    onRetrySlash: () => {},
    onPickSlash: () => {},
    onSlashSel: () => {},
    onHideSlash: () => {},
    onSend: () => {},
    onStop: () => {},
    onPasteImages: () => {},
    onPasteClipboardImage: () => {},
    onRemoveDraftAttachment: () => {},
    onRemoveQueuedPrompt: () => {},
    onSelectAgent: () => {},
    onRescan: () => {}
  }
  return renderToStaticMarkup(<ChatView {...props} {...overrides} />)
}

export { describe, it, expect, vi, attachmentsAfterSuccessfulSubmit, renderToStaticMarkup, createRef, sessionAttentionKey, App, EmptySessionOverview, MAX_SESSION_COMPOSER_DRAFTS, activeRunForSession, adoptLocalStartSessionId, attachmentsAfterFailedSubmit, appendWorkspaceReference, buildForkSessionRequest, applyNewConversationEffects, applyProviderCatalogRefresh, applySessionArchiveEffects, sessionEvidenceGapAfterLoad, applySessionCapturedEffects, applyTurnDoneEffects, commitDraftOnDispatch, dequeueStartedPrompt, enqueuePrompt, failedSlashCatalog, focusedRunNeedsLoading, hasSessionOverviewContext, inputAfterFailedSubmit, inputAfterSuccessfulSubmit, migrateSessionComposerDraft, migrateSessionPromptQueue, providerContextCacheKey, resetQueuedPromptControl, restoreActiveSessionSelection, restoreFocusedRunSelection, sessionComposerDraftKey, updateSessionComposerDraft, updateSessionPromptQueue, dequeueStartedPromptFromSessions, scrollChatTargetIntoView, shouldQueuePrompt, shouldReloadProjectsForDataUpdate, nextDrainableQueuedPrompt, chatBottomDistance, chatBottomStickinessAfterScroll, isChatNearBottom, scrollChatToBottomIfNeeded, resolveRunControlSelection, shouldResetRunControlCatalog, AssistantTurn, RecorderContentPager, UserMessage, attachmentSrc, coalesceAdjacentThinking, WorkspaceFileLinkProvider, ChatView, composerEnterConfirmsIme, composerPromptHistory, filterSlashCommands, formatElapsedMs, imageFilesFromClipboardData, navigateComposerHistory, logicalCallEventsForTurn, overviewToolErrors, OverviewPanel, TurnFileFootprint, TurnToolErrorDetails, turnCallRowsFromMap, Sidebar, ViewChrome, CliPicker, ModelEffortPicker, RunControlSelect, pathContains, WorkspacePanel, workspaceReferenceToken, parseUnifiedDiff, TurnDiffReviewPanel, ArchivedChatsPanel, CapabilitiesModal, filterSkillsForScope, McpModal, SettingsModal, SkillsModal, AnalyticsView, ev, turn, html, RUN_CONTROL_PROPS, renderWelcome }
export type { ComponentProps, ActiveRun, TraceEvent, AgentQuestionRequest, Turn, ParsedTurn, SessionHistoryPage, QueuedPrompt, SessionComposerDraft, SessionEvidenceGap }
