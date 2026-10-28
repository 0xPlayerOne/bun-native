/** Controlled text stays in this document. No clipboard, network, storage or authority access. */
export {}
const text =
  'Bunly controlled text — Café e\u0301 · Ελληνικά · 日本語 · 中文 · 한국어 · العربية · हिन्दी · 🌍'
const draft = document.querySelector<HTMLTextAreaElement>('#draft')!
const role =
  document.documentElement.dataset['surface'] === 'preview'
    ? location.pathname === '/left.html'
      ? 'Left preview'
      : 'Right preview'
    : document.documentElement.dataset['surface'] === 'overlay'
      ? 'Application overlay'
      : 'Application controls'
document.querySelector<HTMLElement>('#surface-name')!.textContent = role
document.title = `Bunly — ${role}`
draft.value = text
const observation = document.querySelector<HTMLElement>('#page-observation')!
const history = document.querySelector<HTMLOListElement>('#page-events')!
const output = document.querySelector<HTMLOListElement>('#numbered-output')
let sequence = 0,
  pulse = 0,
  composing = false,
  inputEvents = 0
function display(): void {
  const selection =
    document.activeElement === draft
      ? Math.abs(draft.selectionEnd - draft.selectionStart)
      : (getSelection()?.toString().length ?? 0)
  observation.textContent = `Focus ${document.hasFocus() ? 'yes' : 'no'} · ${document.visibilityState} · ${innerWidth} × ${innerHeight} CSS px · scale ${devicePixelRatio} · composing ${composing ? 'yes' : 'no'} · inputs ${inputEvents} · selected ${selection}`
}
function event(event: Event): void {
  if (event.type === 'compositionstart') composing = true
  if (event.type === 'compositionend') composing = false
  if (event.type === 'input') inputEvents++
  if (history.children.length === 12) history.firstElementChild?.remove()
  const item = document.createElement('li')
  item.textContent = `${++sequence}. ${event.type}${event instanceof CompositionEvent ? ` (${event.data.length} code units)` : ''}`
  history.append(item)
  display()
}
for (const type of ['focus', 'blur', 'resize']) addEventListener(type, event)
document.addEventListener('visibilitychange', event)
for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'select'])
  draft.addEventListener(type, event)
document.addEventListener('selectionchange', display)
document.querySelector('#reset-text')!.addEventListener('click', () => {
  draft.value = text
  draft.focus()
  display()
})
document.querySelector('#select-text')!.addEventListener('click', () => {
  draft.focus()
  draft.select()
  display()
})
document.querySelector('#local-action')!.addEventListener('click', () => {
  const target = document.querySelector<HTMLElement>('#local-action-result')!
  target.textContent = `${role}: local action ${++sequence}`
})
document.querySelector('#skip-controls')?.addEventListener('click', () => {
  document.querySelector<HTMLElement>('#pane-controls')!.focus()
})
const timer = setInterval(() => {
  if (output) {
    if (output.children.length === 40) output.firstElementChild?.remove()
    const line = document.createElement('li')
    line.textContent = `${String(++pulse).padStart(6, '0')} · ${role} · controlled output`
    output.append(line)
  }
  display()
}, 1000)
addEventListener('pagehide', () => clearInterval(timer), { once: true })
display()
