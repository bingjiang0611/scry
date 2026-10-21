/* Screenshot-derived values live in copy.js. Daily curves below are illustrative only. */
const icons = {
  back: '<path d="m14 6-6 6 6 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>'
}
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`
const dot = (id) => `<span class="series-dot ${id}" aria-hidden="true"></span>`
const series = {
  codex: [0,0,0,0,0,0,0,0,0,43,0,0,0,24,0,0,88,228,805,146,32,154,171,465,188,93,271,367,379,123],
  cc: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,null,0,0,96,31,149,178,186,0,46,62,18,0],
  qoder: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,6,0,0,0,0,0,24,7,8,0]
}
const coords = (values) => values.map((value, index) => ({
  x: index * 900 / (values.length - 1),
  y: 300 - (value ?? 0) * 0.3
}))
// Same midpoint cubic interpolation as AnalyticsView.tsx: smoothPath.
function smoothPath(points) {
  if (points.length === 0) return ''
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index]
    const middle = (previous.x + point.x) / 2
    return `${path} C ${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`
  }, `M ${points[0].x},${points[0].y}`)
}
const line = values => smoothPath(coords(values))
const dayCount = series.codex.length
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const costFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const known = COPY.providers.filter(p => p.width !== null)
document.title = COPY.title
document.querySelector('#app').innerHTML = `
  <aside class="preview">${COPY.preview}</aside>
  <div class="page">
    <header class="page-header">
      <div class="page-title"><button class="icon-button" disabled aria-label="${COPY.back}">${icon('back')}</button><h1>${COPY.heading}</h1><span class="period">${COPY.period}</span></div>
      <div class="page-actions"><div class="range" role="group" aria-label="${COPY.unconnected}">${COPY.periods.map((p,i) => `<button disabled class="${i === 1 ? 'active' : ''}" aria-pressed="${i === 1}">${p}</button>`).join('')}</div><button class="icon-button" disabled aria-label="${COPY.refresh}">${icon('refresh')}</button></div>
    </header>
    <section class="summary" aria-label="${COPY.costLabel}" aria-description="${COPY.basis}">
      <div class="total">
        <h2 class="total-label">${COPY.costLabel}</h2>
        <div class="amount" aria-label="${COPY.totalRaw}"><span class="currency">${COPY.currency}</span>${COPY.totalWhole}<span class="fraction">${COPY.totalFraction}</span></div>
      </div>
      <div class="composition">
        <div class="composition-title"><h2>${COPY.sourceHeading}</h2></div>
        <div class="share-bar" role="img" aria-label="${COPY.distributionLabel}">${known.map(p => `<span class="${p.id}" style="flex-basis:${p.width}%"></span>`).join('')}</div>
        <div class="share-key">${known.map(p => `<div><span>${dot(p.id)}${p.name}</span><strong>${p.share}</strong></div>`).join('')}</div>
      </div>
    </section>
    <div class="analysis">
      <section class="trend" aria-labelledby="chart-title">
        <div class="section-heading"><h2 id="chart-title">${COPY.chartHeading}</h2><div class="metric-toggle"><button disabled class="active" aria-pressed="true">${COPY.cost}</button><button disabled aria-pressed="false" title="${COPY.tokenDisabled}">${COPY.token}</button></div></div>
        <div class="chart-legend">${known.map(p => `<span>${dot(p.id)}${p.name}</span>`).join('')}</div>
        <div class="chart">
          <div class="y-labels">${COPY.yAxis.map(v => `<span>${v}</span>`).join('')}</div>
          <div class="plot">
            <svg class="chart-surface" viewBox="0 0 900 300" preserveAspectRatio="none" role="img" tabindex="0" aria-label="${COPY.chartDescription}" aria-description="${COPY.chartInstructions}">
              <path class="grid" d="M0 1H900M0 150H900M0 299H900"/>
              ${known.map(p => `<path class="area ${p.id}" d="${line(series[p.id])} L900 300H0Z"/>`).join('')}
              ${known.slice().reverse().map(p => `<path class="line ${p.id}" d="${line(series[p.id])}"/>`).join('')}
              <g class="chart-hover" hidden aria-hidden="true"></g>
            </svg>
            <div class="chart-tooltip" role="status" aria-live="polite" hidden></div>
            <div class="x-labels">${COPY.dates.map(d => `<span>${d}</span>`).join('')}</div>
          </div>
        </div>
      </section>
      <section class="providers" aria-labelledby="providers-title">
        <div class="section-heading"><h2 id="providers-title">${COPY.providerHeading}</h2></div>
        <div class="provider-list">${known.map(p => `<article class="provider ${p.id}"><div class="provider-line"><h3>${dot(p.id)}${p.name}</h3><div class="provider-numbers"><span class="provider-share">${p.share}</span><strong>${p.cost}</strong></div></div></article>`).join('')}</div>
      </section>
    </div>
    <section class="tokens" aria-labelledby="tokens-title"><h2 id="tokens-title">${COPY.metricHeading}</h2><dl class="metrics">${COPY.metrics.map(m => `<div class="metric"><dt>${m.label}</dt><dd>${m.value}<span>${m.unit}</span></dd></div>`).join('')}</dl></section>
    <section class="breakdown" aria-labelledby="details-title">
      <div class="section-heading">
        <h2 id="details-title">${COPY.detailsHeading}</h2>
        <div class="metric-toggle" role="group" aria-label="${COPY.detailsDimension}">
          <button disabled class="active" aria-pressed="true">${COPY.detailsModel}</button>
          <button disabled aria-pressed="false" title="${COPY.detailsDateDisabled}">${COPY.detailsDay}</button>
        </div>
      </div>
      <div class="table-wrap">
        <table aria-labelledby="details-title">
          <colgroup><col class="model-column"><col class="cost-column"><col><col></colgroup>
          <thead><tr><th scope="col">${COPY.detailsModel}</th><th scope="col">${COPY.detailsCost}</th><th scope="col">${COPY.detailsShare}</th><th scope="col">${COPY.token}</th></tr></thead>
          <tbody>${COPY.detailRows.map(row => `
            <tr>
              <th scope="row"><span class="model-name">${dot(row.provider)}${row.model}</span></th>
              <td class="detail-cost">${row.cost}</td><td>${row.share}</td><td>${row.tokens}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    </section>
  </div>
`

const chartSurface = document.querySelector('.chart-surface')
const hover = document.querySelector('.chart-hover')
const tooltip = document.querySelector('.chart-tooltip')
let hoverIndex = null

function hideDay() {
  hoverIndex = null
  hover.setAttribute('hidden', '')
  tooltip.hidden = true
}

function showDay(index, bounds = chartSurface.getBoundingClientRect()) {
  if (hoverIndex === index) return
  hoverIndex = index
  const x = index * 900 / (dayCount - 1)
  const day = dateFormatter.format(new Date(Date.UTC(2026, 8, 22 + index)))
  hover.innerHTML = `<line x1="${x}" x2="${x}" y1="0" y2="300"/>${known.map(p => {
    const value = series[p.id][index]
    return value === null ? '' : `<circle class="${p.id}" cx="${x}" cy="${300 - value * 0.3}" r="4"/>`
  }).join('')}`
  tooltip.innerHTML = `<b>${day}</b>${known.map(p => {
    const value = series[p.id][index]
    return `<div class="tooltip-row">${dot(p.id)}<span>${p.name}</span><strong>${value === null ? COPY.chartMissingValue : costFormatter.format(value)}</strong>${value === null ? `<small>${COPY.chartNoRecord}</small>` : ''}</div>`
  }).join('')}`
  const tooltipWidth = Math.min(232, bounds.width - 16)
  const pointX = index * bounds.width / (dayCount - 1)
  const left = pointX + 12 + tooltipWidth > bounds.width ? pointX - tooltipWidth - 12 : pointX + 12
  tooltip.style.left = `${Math.max(8, Math.min(bounds.width - tooltipWidth - 8, left))}px`
  hover.removeAttribute('hidden')
  tooltip.hidden = false
}

chartSurface.addEventListener('pointermove', event => {
  const bounds = chartSurface.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
  showDay(Math.round(ratio * (dayCount - 1)), bounds)
})
chartSurface.addEventListener('pointerleave', hideDay)
chartSurface.addEventListener('focus', () => {
  if (hoverIndex === null) showDay(dayCount - 1)
})
chartSurface.addEventListener('blur', hideDay)
chartSurface.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideDay()
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = hoverIndex ?? dayCount - 1
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? dayCount - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1)
  showDay(Math.max(0, Math.min(dayCount - 1, index)))
})
window.addEventListener('resize', hideDay)
