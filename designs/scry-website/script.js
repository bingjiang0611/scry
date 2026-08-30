document.documentElement.classList.add('js')

const heroButtons = [...document.querySelectorAll('[data-hero-choice]')]
const heroKey = 'scry.website.hero'

function setHero(hero) {
  const next = hero === 'grid' ? 'grid' : 'aperture'
  document.documentElement.dataset.hero = next
  heroButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.heroChoice === next))
  })
  try {
    localStorage.setItem(heroKey, next)
  } catch {
    // The visual choice still works when storage is unavailable.
  }
}

let storedHero
try {
  storedHero = localStorage.getItem(heroKey)
} catch {
  storedHero = null
}
setHero(storedHero || document.documentElement.dataset.hero)
heroButtons.forEach((button) => button.addEventListener('click', () => setHero(button.dataset.heroChoice)))

const liveStages = [...document.querySelectorAll('.live-stage')]
function fitLiveStages() {
  liveStages.forEach((stage) => {
    const surface = stage.querySelector('.live-surface')
    const width = stage.clientWidth
    if (surface && width > 0) surface.style.transform = `scale(${width / 1280})`
  })
}
fitLiveStages()
requestAnimationFrame(fitLiveStages)
const liveStageObserver = 'ResizeObserver' in window ? new ResizeObserver(fitLiveStages) : null
if (liveStageObserver) {
  liveStages.forEach((stage) => liveStageObserver.observe(stage))
} else {
  window.addEventListener('resize', fitLiveStages)
}

const showcaseButtons = [...document.querySelectorAll('[data-showcase]')]
const showcasePanels = [...document.querySelectorAll('.showcase-panel')]
const showcaseFullLink = document.querySelector('[data-showcase-full]')

function setShowcase(name, focus = false) {
  showcaseButtons.forEach((button) => {
    const active = button.dataset.showcase === name
    button.setAttribute('aria-selected', String(active))
    button.tabIndex = active ? 0 : -1
    if (active && focus) button.focus()
  })
  showcasePanels.forEach((panel) => {
    const active = panel.id === `panel-${name}`
    panel.hidden = !active
    panel.classList.toggle('is-active', active)
  })
  showcaseFullLink.href = name === 'analysis' ? 'assets/analytics-live.html' : 'assets/chat-live.html'
  requestAnimationFrame(fitLiveStages)
}

showcaseButtons.forEach((button, index) => {
  button.addEventListener('click', () => setShowcase(button.dataset.showcase))
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + delta + showcaseButtons.length) % showcaseButtons.length
    setShowcase(showcaseButtons[nextIndex].dataset.showcase, true)
  })
})

const toast = document.querySelector('.toast')
let toastTimer

function showToast(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  showToast('Clone 命令已复制')
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => copyText(button.dataset.copy))
})

const reveals = [...document.querySelectorAll('.reveal')]
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    })
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  reveals.forEach((element) => observer.observe(element))
} else {
  reveals.forEach((element) => element.classList.add('is-visible'))
}
