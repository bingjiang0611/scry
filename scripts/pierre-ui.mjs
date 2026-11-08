// Expressions for the open shadow roots used by @pierre/diffs and @pierre/trees.
// Callers still pass the resulting strings to the existing renderer evaluator.
export function pierreDiffEval(expression) {
  return `(() => {
    const roots = [...document.querySelectorAll('.pierre-code-view diffs-container')]
      .map(host => host.shadowRoot).filter(Boolean)
    return (${expression})
  })()`
}

export function pierreDiffHasText(text) {
  return pierreDiffEval(`roots.some(root => root.textContent.includes(${JSON.stringify(text)}))`)
}

export function pierreDiffLineCount() {
  return pierreDiffEval(`roots.reduce((count, root) => count + root.querySelectorAll('[data-line]').length, 0)`)
}

export function pierreDiffLineGeometry(text) {
  return pierreDiffEval(`(() => {
    const line = roots.flatMap(root => [...root.querySelectorAll('[data-line]')])
      .find(node => node.textContent.includes(${JSON.stringify(text)}))
    return line ? { height: line.getBoundingClientRect().height, left: line.getBoundingClientRect().left,
      right: line.getBoundingClientRect().right, number: line.getAttribute('data-line') } : null
  })()`)
}

export function pierreDiffLinesForText(texts) {
  return pierreDiffEval(`roots.flatMap(root => [...root.querySelectorAll('[data-line]')])
    .filter(node => ${JSON.stringify(texts)}.some(text => node.textContent.includes(text)))
    .map(node => ({ number: node.getAttribute('data-line'), text: node.textContent }))`)
}

export function pierreTreeEval(expression) {
  return `(() => {
    const roots = [...document.querySelectorAll('file-tree-container')]
      .map(host => host.shadowRoot).filter(Boolean)
    return (${expression})
  })()`
}

export function pierreTreeHasText(text) {
  return pierreTreeEval(`roots.flatMap(root => [...root.querySelectorAll('[data-item-path]')])
    .some(node => node.textContent.includes(${JSON.stringify(text)}) || node.getAttribute('data-item-path')?.includes(${JSON.stringify(text)}))`)
}

export function pierreTreeAttribute(selector, attribute) {
  return pierreTreeEval(`roots.flatMap(root => [...root.querySelectorAll(${JSON.stringify(selector)})])
    .map(node => node.getAttribute(${JSON.stringify(attribute)})).find(Boolean)`)
}

export function pierreTreeVisibleCount(selector = '[role="treeitem"]') {
  return pierreTreeEval(`roots.reduce((count, root) => count + [...root.querySelectorAll(${JSON.stringify(selector)})]
    .filter(node => node.getBoundingClientRect().height > 0).length, 0)`)
}
