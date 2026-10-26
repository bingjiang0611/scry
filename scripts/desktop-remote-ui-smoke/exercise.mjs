import { createNativeDriver } from './native-driver.mjs'
import { runVisibilityPollingBaseline } from './visibility-baseline.mjs'
import { runVisibilityPollingCheck } from './visibility-check.mjs'
import { runInitialControls } from './initial-controls.mjs'
import { runUnknownReceipt } from './unknown-receipt.mjs'
import { runStructure } from './structure.mjs'
import { runOpeningControls } from './opening-controls.mjs'
import { runOpeningMeasurement } from './opening-measurement.mjs'
import { runSettings } from './settings.mjs'
import { runSidebarActivity } from './sidebar-activity.mjs'
import { runComposerHistory } from './composer-history.mjs'
import { runSessionRouting } from './session-routing.mjs'
import { runLifecycle } from './lifecycle.mjs'
import { runParity } from './parity.mjs'
import { runWorkbench } from './workbench.mjs'
import { runDirectorySelection } from './directory-selection.mjs'
import { runDispatch } from './dispatch.mjs'
import { runRouting } from './routing.mjs'
import { runHostSettings } from './host-settings.mjs'
import { buildResult } from './result.mjs'

export async function exercise(contents, pointer, capture, options) {
  const driver = createNativeDriver(contents, pointer, capture)
  const { check, read, wait } = driver
  if (options.visibilityPollingBaseline) return runVisibilityPollingBaseline(driver)
  if (options.visibilityPollingCheck) return runVisibilityPollingCheck(driver)

  const initial = await runInitialControls(driver, options)
  if (initial) return initial
  await wait('document.querySelector(".sb-remote-proj") != null', 'connected remote project')
  check(!(await read('document.querySelector(".sb-hosts")')), 'Legacy hosts navigation remains')

  if (options.unknownReceiptOnly) return runUnknownReceipt({ driver, options })
  await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.textContent === "Fixture desktop"', 'remote project tagged with host in sidebar')
  await wait('document.querySelector(".location-button") != null', 'machine + project picker in composer')
  if (options.structureOnly) return runStructure({ driver })
  if (options.openingOnly || options.measureOpening) {
    const openingControls = await runOpeningControls({ driver, options })
    if (openingControls) return openingControls
    return runOpeningMeasurement({ driver, options })
  }
  const settings = await runSettings({ driver, options })
  if (settings) return settings
  await runSidebarActivity({ driver, options })
  if (options.scenario === 'activity') return {
    remoteSidebarActivity: { activityTab: true, activitySelection: true, reconnectRestoresCompleted: true, unreadCompletion: true, focusedViewClearsUnread: true, repeatedCatalogDoesNotRemark: true, failedCatalogRemoved: true, idleNotCompleted: true, backgroundStartStop: true, sharedSpinner: true, recentProjectOrder: true, localPinsPreserved: true, staleReadNotLive: true, collapseSurvivesSearch: true },
    nativeCoordinateInput: true
  }
  if (options.composerHistoryOnly) return runComposerHistory({ driver })
  await runSessionRouting({ driver })
  if (options.lifecycleOnly) return runLifecycle({ driver })
  if (options.parityOnly) return runParity({ driver })
  if (options.scenario === 'workbench') {
    await runWorkbench({ driver })
    return {
      remoteWorkbench: { sharedTabsAndColumns: true, resize: true, maximizeRestore: true, sessionScopedTabs: true, treePagination: true, snapshotFilePagination: true, markdownPreview: true, unsupportedPreviewNeverLocal: true, unavailableTerminal: true },
      remoteOverviewTurnNavigation: true, nativeCoordinateInput: true
    }
  }
  if (options.scenario === 'hosts') {
    // Host management used to inherit the runtime's third authorized project.
    // Seed it through the fixture bridge; native selection/no-send remains in runtime.
    // Keep catalogRevision at zero so the later reconnect still proves fresh v2 data.
    await read('window.scry.desktopRemote.selectDirectory("fixture-connection", "/fixture/home/custom").then(() => window.refreshFixtureCatalog())')
    const before = await driver.fixture()
    await runHostSettings({ driver, localBefore: before.localNewSessions, submissionsBefore: before.submitInputs.length })
    return {
      hostAddressEdit: { cancel: true, focusRestored: true, validation: true, storageFailure: true, doubleEnterSingleSave: true, identityKept: true, explicitReconnect: true, noProviderStart: true },
      boundSessionReconnectRefreshesCatalog: true, savedHostsAfterRendererReload: true,
      remoteSettingsSeparateConnectionDirections: true, nativeCoordinateInput: true
    }
  }
  const localBefore = await runDirectorySelection({ driver })
  await runDispatch({ driver })
  const finalState = await runRouting({ driver, localBefore })
  return buildResult({ finalState })
}
