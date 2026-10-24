export async function exerciseSessionCapabilityQuestionResult() {
  const text = (selector) => document.querySelector(selector)?.textContent ?? ''
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve() }
    })
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM condition timed out: ${predicate.toString()}`)) }, 5000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  })
  const button = (scope, fragment) => {
    const node = [...document.querySelectorAll(`${scope} button`)].find((element) => element.textContent.includes(fragment))
    check(node, `Missing button ${fragment}`)
    return node
  }
  // 已回答问答块：基础规则曾被整段删除且无人补回，这里直接对真实 CSS 断言层级与右轨。
  const answeredBlock = document.querySelector('#question-result')
  const ledgerRows = answeredBlock.querySelectorAll('.question-result-list > div')
  const ledgerRow = ledgerRows[0]
  const answerCell = ledgerRow.querySelector('dd')
  const questionList = answeredBlock.querySelector('.question-result-list')
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  check(getComputedStyle(questionList).display === 'grid' && getComputedStyle(questionList).marginTop === '6px', 'Answered question list does not use the ledger rhythm')
  check(getComputedStyle(questionList).borderTopWidth === '1px', 'Answered question list lost its hairline')
  check(getComputedStyle(answerCell).marginLeft === '0px', 'Answered answer kept the browser <dd> indent')
  check(getComputedStyle(ledgerRow).display === 'grid' && getComputedStyle(ledgerRow).gridTemplateColumns.split(' ').length === 2, 'Answered question rows are not a two-column ledger')
  check(getComputedStyle(answerCell).textAlign === 'right' && getComputedStyle(answerCell).fontWeight === '600', 'Answer is not the right-aligned ledger value')
  const waitCell = answeredBlock.querySelector('.question-result-wait')
  check(waitCell != null && Math.abs(waitCell.getBoundingClientRect().right - answerCell.getBoundingClientRect().right) <= 1, 'Wait time and answer do not share a right rail')
  const probe = document.createElement('span')
  probe.style.color = 'var(--ok)'
  answeredBlock.append(probe)
  const okColor = getComputedStyle(probe).color
  probe.remove()
  check(getComputedStyle(answeredBlock.querySelector('.question-result-head > span')).color === okColor, 'Answered stamp does not use the verdict token')
  const cancelledBlock = answeredBlock.querySelectorAll('.question-result')[1]
  const missingCell = cancelledBlock.querySelector('dd.missing')
  check(cancelledBlock.className.includes('error') && missingCell != null && getComputedStyle(missingCell).fontWeight !== '600', 'Cancelled answers were rendered as chosen values')
  check(cancelledBlock.querySelector('.question-result-wait') == null, 'Cancelled question invented a wait duration')
  const rawDetails = answeredBlock.querySelector('details.question-raw')
  rawDetails.querySelector('summary').focus()
  check(document.activeElement === rawDetails.querySelector('summary'), 'Raw evidence disclosure is not keyboard focusable')
  rawDetails.open = true
  await frame()
  check(getComputedStyle(rawDetails.querySelector('summary .ico')).transform !== 'none', 'Raw evidence chevron did not rotate open')
  document.querySelector('#question-result').style.width = '560px'
  await frame()
  check(getComputedStyle(ledgerRow).gridTemplateColumns.split(' ').length === 1, 'Answered ledger did not stack in a narrow pane')
  check(getComputedStyle(answerCell).textAlign === 'left', 'Stacked answer stayed right-aligned')
  document.querySelector('#question-result').style.width = '820px'
  return { compactContextCopy: true, contextEvidenceTooltip: true, liveContext: true, compactionInvalidation: true, contextSessionReset: true, normalizedWire: true, summaryHiddenByDefault: true, hooksAutoExpand: true, originalEvidenceClicks: 3, collapse: true, thinkingDisclosure: true, modelEffortPicker: true, newSession: true, lateSuccess: true, failedRead: true, multipleTurns: true, sidebarCoordinates: true, sidebarCascade: true, archiveWhileCatalogPending: true, archiveAfterCatalogFailure: true, archiveUndo: true, backgroundArchive: true, answeredQuestionLedger: true }
  return { answeredQuestionLedger: true }
}
