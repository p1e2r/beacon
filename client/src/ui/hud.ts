// In-game overlay: hotbar, health, chat, titles, tab list, screens.
import { toDom, toPlain, Component } from '../game/text'
import type { BlockAssets } from '../render/assets'
import { lock, unlock, isTouch } from './lock'

export type Slot = { name: string; label: string; count: number; tex: string | null; color: number } | null

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  parent?.appendChild(e)
  return e
}

export class Hud {
  root: HTMLElement
  typing = false
  debugOn = false
  inventoryOpen = false
  onChatSend: (m: string) => void = () => {}
  onRespawn: () => void = () => {}
  onCloseContainer: () => void = () => {}
  onLeave: () => void = () => {}
  onResume: () => void = () => {}
  private chatLog: HTMLElement
  private chatInput: HTMLInputElement
  private chatHistory: string[] = []
  private histPos = -1
  private hotbar: HTMLElement
  get hotbarEl() { return this.hotbar }
  /** Called with true while any menu, chat or inventory covers the game. */
  onScreensChanged: (open: boolean) => void = () => {}
  private hearts: HTMLElement
  private foodEl: HTMLElement
  private xpEl: HTMLElement
  private titleEl: HTMLElement
  private subEl: HTMLElement
  private actionEl: HTMLElement
  private tabEl: HTMLElement
  private debugEl: HTMLElement
  private statusEl: HTMLElement
  private deathEl: HTMLElement
  private pauseEl: HTMLElement
  private containerEl: HTMLElement
  private toastEl: HTMLElement
  private crack: HTMLElement
  private titleTimer = 0
  private actionTimer = 0
  private times = { fadeIn: 10, stay: 70, fadeOut: 20 }
  private gamemode = 0
  private assets: BlockAssets | null = null
  private iconCache = new Map<string, string>()

  constructor(root: HTMLElement) {
    this.root = root
    root.innerHTML = ''
    el('div', 'crosshair', root)
    this.crack = el('div', 'dig', root)
    this.statusEl = el('div', 'status', root)
    this.titleEl = el('div', 'title', root)
    this.subEl = el('div', 'subtitle', root)
    this.actionEl = el('div', 'actionbar', root)
    const bottom = el('div', 'bottom', root)
    const bars = el('div', 'bars', bottom)
    this.hearts = el('div', 'hearts', bars)
    this.foodEl = el('div', 'food', bars)
    this.xpEl = el('div', 'xp', bottom)
    this.hotbar = el('div', 'hotbar', bottom)
    for (let i = 0; i < 9; i++) el('div', 'slot', this.hotbar)
    this.chatLog = el('div', 'chat', root)
    this.chatInput = el('input', 'chatinput', root)
    this.chatInput.maxLength = 256
    this.chatInput.spellcheck = false
    this.chatInput.addEventListener('keydown', e => this.chatKey(e))
    this.tabEl = el('div', 'tablist hidden', root)
    this.debugEl = el('div', 'debug hidden', root)
    this.deathEl = el('div', 'screen death hidden', root)
    this.pauseEl = el('div', 'screen pause hidden', root)
    this.containerEl = el('div', 'screen container hidden', root)
    this.toastEl = el('div', 'hudtoast', root)
    this.setHealth(20, 20)
  }

  // ---------------- chat
  chat(c: Component) {
    const line = el('div', 'line', this.chatLog)
    line.appendChild(toDom(c))
    line.dataset.t = String(Date.now())
    while (this.chatLog.children.length > 100) this.chatLog.firstChild!.remove()
    this.chatLog.scrollTop = this.chatLog.scrollHeight
    console.log('[chat]', toPlain(c))
  }
  openChat(prefix: string) {
    this.typing = true
    this.root.classList.add('typing')
    this.chatInput.value = prefix
    this.chatInput.style.display = 'block'
    setTimeout(() => this.chatInput.focus(), 0)
    this.histPos = -1
    this.notify()
  }
  private closeChat() {
    this.typing = false
    this.root.classList.remove('typing')
    this.chatInput.style.display = 'none'
    this.chatInput.blur()
    ;lock(document.querySelector('#game'))
    this.notify()
  }
  private chatKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const v = this.chatInput.value
      if (v.trim()) { this.onChatSend(v); this.chatHistory.unshift(v); this.chatHistory.length = Math.min(50, this.chatHistory.length) }
      this.closeChat()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.closeChat()
    } else if (e.key === 'ArrowUp') {
      if (this.histPos < this.chatHistory.length - 1) this.chatInput.value = this.chatHistory[++this.histPos]
      e.preventDefault()
    } else if (e.key === 'ArrowDown') {
      this.histPos = Math.max(-1, this.histPos - 1)
      this.chatInput.value = this.histPos >= 0 ? this.chatHistory[this.histPos] : ''
      e.preventDefault()
    }
  }

  // ---------------- titles
  titleTimes(fadeIn: number, stay: number, fadeOut: number) {
    this.times = { fadeIn, stay, fadeOut }
  }
  title(c: Component | null) {
    clearTimeout(this.titleTimer)
    this.titleEl.innerHTML = ''
    if (c === null) { this.subEl.innerHTML = ''; return }
    this.titleEl.appendChild(toDom(c))
    this.titleEl.classList.add('show'); this.subEl.classList.add('show')
    this.titleTimer = window.setTimeout(() => { this.titleEl.classList.remove('show'); this.subEl.classList.remove('show'); this.subEl.innerHTML = '' }, ((this.times.fadeIn + this.times.stay) * 50))
  }
  subtitle(c: Component) {
    this.subEl.innerHTML = ''
    this.subEl.appendChild(toDom(c))
  }
  actionBar(c: Component) {
    clearTimeout(this.actionTimer)
    this.actionEl.innerHTML = ''
    this.actionEl.appendChild(toDom(c))
    this.actionEl.classList.add('show')
    this.actionTimer = window.setTimeout(() => this.actionEl.classList.remove('show'), 3000)
  }
  status(text: string | null) {
    this.statusEl.textContent = text ?? ''
    this.statusEl.classList.toggle('show', !!text)
  }
  toast(text: string) {
    this.toastEl.textContent = text
    this.toastEl.classList.add('show')
    setTimeout(() => this.toastEl.classList.remove('show'), 4000)
  }

  // ---------------- bars
  setGamemode(gm: number) {
    this.gamemode = gm
    this.root.classList.toggle('creative', gm === 1 || gm === 3)
    this.root.classList.toggle('spectator', gm === 3)
  }
  setHealth(h: number, food: number) {
    const hearts = Math.max(0, Math.ceil(h))
    this.hearts.innerHTML = ''
    for (let i = 0; i < 10; i++) el('span', hearts >= (i + 1) * 2 ? 'full' : hearts === i * 2 + 1 ? 'half' : 'empty', this.hearts)
    this.foodEl.innerHTML = ''
    for (let i = 9; i >= 0; i--) el('span', food >= (i + 1) * 2 ? 'full' : food === i * 2 + 1 ? 'half' : 'empty', this.foodEl)
  }
  setXp(level: number, bar: number) {
    this.xpEl.style.setProperty('--xp', String(Math.max(0, Math.min(1, bar))))
    this.xpEl.textContent = level > 0 ? String(level) : ''
  }
  digProgress(f: number) {
    this.crack.style.setProperty('--p', String(Math.max(0, Math.min(1, f))))
    this.crack.classList.toggle('show', f > 0)
  }

  private icon(s: NonNullable<Slot>): HTMLElement {
    const d = document.createElement('div')
    d.className = 'icon'
    if (s.tex && this.assets?.textured) {
      let url = this.iconCache.get(s.tex)
      if (!url) {
        const a = this.assets.atlas
        const i = a.slots.get(s.tex) ?? 0
        const c = document.createElement('canvas')
        c.width = c.height = a.tile
        c.getContext('2d')!.drawImage(a.canvas, (i % a.cols) * a.tile, Math.floor(i / a.cols) * a.tile, a.tile, a.tile, 0, 0, a.tile, a.tile)
        url = c.toDataURL()
        this.iconCache.set(s.tex, url)
      }
      d.style.backgroundImage = `url(${url})`
    } else {
      d.style.background = '#' + s.color.toString(16).padStart(6, '0')
      d.classList.add('flat')
      d.textContent = s.label.slice(0, 2)
    }
    if (s.count > 1) el('span', 'count', d).textContent = String(s.count)
    d.title = s.label
    return d
  }
  setHotbar(slots: Slot[], selected: number, assets: BlockAssets) {
    this.assets = assets
    ;[...this.hotbar.children].forEach((c, i) => {
      c.innerHTML = ''
      c.classList.toggle('sel', i === selected)
      const s = slots[i]
      if (s) c.appendChild(this.icon(s))
    })
    const s = slots[selected]
    if (s) { this.actionEl.textContent = s.label; this.actionEl.classList.add('show'); clearTimeout(this.actionTimer); this.actionTimer = window.setTimeout(() => this.actionEl.classList.remove('show'), 1500) }
  }

  // ---------------- screens
  private notify() {
    const open = this.anyScreenOpen() || this.inventoryOpen
    this.root.classList.toggle('screen-open', open)
    this.onScreensChanged(open)
  }
  anyScreenOpen() {
    return this.typing || !this.deathEl.classList.contains('hidden') || !this.pauseEl.classList.contains('hidden') || !this.containerEl.classList.contains('hidden')
  }
  death(msg: Component | null) {
    if (msg === null) { this.deathEl.classList.add('hidden'); this.notify(); return }
    unlock()
    this.deathEl.innerHTML = ''
    el('h1', '', this.deathEl).textContent = 'You died!'
    const m = el('p', '', this.deathEl)
    if (typeof msg !== 'string' || msg !== 'You died!') m.appendChild(toDom(msg))
    const b = el('button', 'btn', this.deathEl)
    b.textContent = 'Respawn'
    b.onclick = () => { this.onRespawn(); this.deathEl.classList.add('hidden'); lock(document.querySelector('#game')) }
    this.deathEl.classList.remove('hidden')
    this.notify()
  }
  showPause(on: boolean) {
    this.pauseEl.innerHTML = ''
    if (!on) { this.pauseEl.classList.add('hidden'); this.notify(); return }
    el('h1', '', this.pauseEl).textContent = 'Game menu'
    const resume = el('button', 'btn', this.pauseEl)
    resume.textContent = 'Back to game'
    resume.onclick = () => { this.showPause(false); this.onResume() }
    const leave = el('button', 'btn', this.pauseEl)
    leave.textContent = 'Disconnect'
    leave.onclick = () => { this.showPause(false); this.onLeave() }
    el('p', 'hint', this.pauseEl).textContent = isTouch ? 'Left stick: move (push to the edge to sprint) · drag: look · tap: place/use · hold: break/attack · ⇧ jump (double-tap to fly) · ⇩ sneak · tap the hotbar to switch items' : 'WASD move · Space jump (double-tap to fly) · Shift sneak · Ctrl sprint · T chat · / command · E inventory · Tab players · F3 debug'
    this.pauseEl.classList.remove('hidden')
    this.notify()
  }
  showContainer(title: string | null, slots: Slot[]) {
    if (title === null) { this.containerEl.classList.add('hidden'); this.notify(); return }
    this.containerEl.innerHTML = ''
    el('h2', '', this.containerEl).textContent = title
    const grid = el('div', 'grid', this.containerEl)
    for (const s of slots.slice(0, Math.max(0, slots.length - 36))) { const c = el('div', 'slot', grid); if (s) c.appendChild(this.icon(s)) }
    el('p', 'hint', this.containerEl).textContent = 'Viewing only — moving items isn’t supported yet.'
    const b = el('button', 'btn', this.containerEl)
    b.textContent = 'Close (E)'
    b.onclick = () => this.onCloseContainer()
    this.containerEl.classList.remove('hidden')
    this.notify()
  }
  showInventory(inv: Slot[] | null) {
    this.inventoryOpen = !!inv
    if (!inv) { this.containerEl.classList.add('hidden'); this.notify(); return }
    this.containerEl.innerHTML = ''
    el('h2', '', this.containerEl).textContent = 'Inventory'
    const armor = el('div', 'grid armor', this.containerEl)
    for (let i = 5; i <= 8; i++) { const c = el('div', 'slot', armor); if (inv[i]) c.appendChild(this.icon(inv[i]!)) }
    const grid = el('div', 'grid', this.containerEl)
    for (let i = 9; i <= 35; i++) { const c = el('div', 'slot', grid); if (inv[i]) c.appendChild(this.icon(inv[i]!)) }
    const hb = el('div', 'grid hb', this.containerEl)
    for (let i = 36; i <= 44; i++) { const c = el('div', 'slot', hb); if (inv[i]) c.appendChild(this.icon(inv[i]!)) }
    el('p', 'hint', this.containerEl).textContent = 'Viewing only — use 1-9 or the scroll wheel to pick hotbar items.'
    this.containerEl.classList.remove('hidden')
    this.notify()
  }
  confirm(title: string, text: string, yes: string, no: string): Promise<boolean> {
    return new Promise(resolve => {
      unlock()
      const d = el('div', 'screen confirm', this.root)
      el('h2', '', d).textContent = title
      el('pre', '', d).textContent = text
      const row = el('div', 'row', d)
      const a = el('button', 'btn', row); a.textContent = yes
      const b = el('button', 'btn', row); b.textContent = no
      a.onclick = () => { d.remove(); resolve(true) }
      b.onclick = () => { d.remove(); resolve(false) }
    })
  }

  // ---------------- tab / debug
  updateTab(players: Map<string, { name: string; latency: number; listed: boolean; display: any; gamemode: number }>, header: any, footer: any) {
    this.tabEl.innerHTML = ''
    if (header && toPlain(header)) el('div', 'hdr', this.tabEl).appendChild(toDom(header))
    const list = el('div', 'players', this.tabEl)
    const sorted = [...players.values()].filter(p => p.listed).sort((a, b) => (a.gamemode === 3 ? 1 : 0) - (b.gamemode === 3 ? 1 : 0) || a.name.localeCompare(b.name))
    for (const p of sorted) {
      const r = el('div', 'p' + (p.gamemode === 3 ? ' spec' : ''), list)
      r.appendChild(p.display ? toDom(p.display) : document.createTextNode(p.name))
      el('span', 'ping', r).textContent = p.latency >= 0 ? `${p.latency}ms` : ''
    }
    if (footer && toPlain(footer)) el('div', 'ftr', this.tabEl).appendChild(toDom(footer))
  }
  showTab(on: boolean) {
    this.tabEl.classList.toggle('hidden', !on)
  }
  toggleDebug() {
    this.debugOn = !this.debugOn
    this.debugEl.classList.toggle('hidden', !this.debugOn)
  }
  setDebug(lines: string[]) {
    this.debugEl.textContent = lines.filter(Boolean).join('\n')
  }
}
