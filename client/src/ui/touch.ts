// On-screen controls for phones and tablets.
//
// Left: move stick (push to the edge to sprint). Anywhere else: drag to look,
// tap to place/use, hold still to break/attack. Buttons: jump (double-tap to fly),
// sneak (toggle), chat, inventory, players, menu. The hotbar is tappable.

export interface TouchTarget {
  touchMove(forward: number, strafe: number, sprint: boolean): void
  touchLook(dx: number, dy: number): void
  touchKey(key: 'jump' | 'sneak', on: boolean): void
  touchUse(): void
  touchBreak(on: boolean): void
  selectSlot(n: number): void
  openChat(): void
  toggleInventory(): void
  showPlayers(on: boolean): void
  pause(): void
  get sneaking(): boolean
}

const HOLD_MS = 280
const TAP_MOVE = 12

export class TouchControls {
  root: HTMLElement
  private stick: HTMLElement
  private knob: HTMLElement
  private sneakBtn: HTMLElement
  private stickId: number | null = null
  private stickOrigin = { x: 0, y: 0 }
  private looks = new Map<number, { x: number; y: number; sx: number; sy: number; t: number; moved: boolean; holding: boolean; timer: number }>()
  private lastJump = 0

  constructor(parent: HTMLElement, private t: TouchTarget, private sensitivity: () => number) {
    this.root = document.createElement('div')
    this.root.className = 'touch'
    this.root.innerHTML = `
      <div class="t-look"></div>
      <div class="t-stick"><div class="t-knob"></div></div>
      <div class="t-top">
        <button data-a="chat" aria-label="Chat">💬</button>
        <button data-a="players" aria-label="Players">👥</button>
        <button data-a="inv" aria-label="Inventory">🎒</button>
        <button data-a="menu" aria-label="Menu">⏸</button>
      </div>
      <div class="t-right">
        <button class="t-sneak" data-a="sneak" aria-label="Sneak">⇩</button>
        <button class="t-jump" data-a="jump" aria-label="Jump">⇧</button>
      </div>`
    parent.appendChild(this.root)
    this.stick = this.root.querySelector('.t-stick')!
    this.knob = this.root.querySelector('.t-knob')!
    this.sneakBtn = this.root.querySelector('.t-sneak')!
    const look = this.root.querySelector('.t-look') as HTMLElement

    this.stick.addEventListener('touchstart', e => this.stickStart(e), { passive: false })
    look.addEventListener('touchstart', e => this.lookStart(e), { passive: false })
    window.addEventListener('touchmove', this.onMove, { passive: false })
    window.addEventListener('touchend', this.onEnd, { passive: false })
    window.addEventListener('touchcancel', this.onEnd, { passive: false })

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      const a = b.dataset.a!
      b.addEventListener('touchstart', e => {
        e.preventDefault()
        e.stopPropagation()
        b.classList.add('down')
        if (a === 'jump') {
          const now = performance.now()
          if (now - this.lastJump < 300) this.t.touchKey('jump', false), this.flyToggle()
          this.lastJump = now
          this.t.touchKey('jump', true)
        } else if (a === 'sneak') {
          const on = !this.t.sneaking
          this.t.touchKey('sneak', on)
          b.classList.toggle('on', on)
        } else if (a === 'chat') this.t.openChat()
        else if (a === 'inv') this.t.toggleInventory()
        else if (a === 'players') this.t.showPlayers(true)
        else if (a === 'menu') this.t.pause()
      }, { passive: false })
      b.addEventListener('touchend', e => {
        e.preventDefault()
        b.classList.remove('down')
        if (a === 'jump') this.t.touchKey('jump', false)
        if (a === 'players') this.t.showPlayers(false)
      }, { passive: false })
    }
  }

  /** Double-tapping jump toggles flight in creative, like double-tapping space. */
  onFlyToggle: () => void = () => {}
  private flyToggle() {
    this.onFlyToggle()
  }

  bindHotbar(hotbar: HTMLElement) {
    hotbar.addEventListener('touchstart', e => {
      const slot = (e.target as HTMLElement).closest('.slot')
      if (!slot) return
      e.preventDefault()
      e.stopPropagation()
      const i = [...hotbar.children].indexOf(slot)
      if (i >= 0) this.t.selectSlot(i)
    }, { passive: false })
  }

  setSneak(on: boolean) {
    this.sneakBtn.classList.toggle('on', on)
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on)
    if (!on) this.release()
  }

  release() {
    this.stickId = null
    this.knob.style.transform = ''
    this.t.touchMove(0, 0, false)
    for (const l of this.looks.values()) {
      clearTimeout(l.timer)
      if (l.holding) this.t.touchBreak(false)
    }
    this.looks.clear()
    this.t.touchKey('jump', false)
  }

  destroy() {
    this.release()
    window.removeEventListener('touchmove', this.onMove)
    window.removeEventListener('touchend', this.onEnd)
    window.removeEventListener('touchcancel', this.onEnd)
    this.root.remove()
  }

  private stickStart(e: TouchEvent) {
    e.preventDefault()
    if (this.stickId !== null) return
    const touch = e.changedTouches[0]
    const r = this.stick.getBoundingClientRect()
    this.stickId = touch.identifier
    this.stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    this.updateStick(touch.clientX, touch.clientY)
  }

  private updateStick(x: number, y: number) {
    const max = this.stick.clientWidth / 2
    let dx = x - this.stickOrigin.x, dy = y - this.stickOrigin.y
    const d = Math.hypot(dx, dy)
    if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`
    const nx = dx / max, ny = dy / max
    const mag = Math.hypot(nx, ny)
    const dead = 0.18
    if (mag < dead) return this.t.touchMove(0, 0, false)
    this.t.touchMove(-ny, nx, mag > 0.92)
  }

  private lookStart(e: TouchEvent) {
    e.preventDefault()
    for (const touch of e.changedTouches) {
      const l = { x: touch.clientX, y: touch.clientY, sx: touch.clientX, sy: touch.clientY, t: performance.now(), moved: false, holding: false, timer: 0 }
      l.timer = window.setTimeout(() => {
        if (!l.moved) { l.holding = true; this.t.touchBreak(true) }
      }, HOLD_MS)
      this.looks.set(touch.identifier, l)
    }
  }

  private onMove = (e: TouchEvent) => {
    let handled = false
    for (const touch of e.changedTouches) {
      if (touch.identifier === this.stickId) {
        this.updateStick(touch.clientX, touch.clientY)
        handled = true
        continue
      }
      const l = this.looks.get(touch.identifier)
      if (!l) continue
      handled = true
      const dx = touch.clientX - l.x, dy = touch.clientY - l.y
      l.x = touch.clientX; l.y = touch.clientY
      if (!l.moved && Math.hypot(touch.clientX - l.sx, touch.clientY - l.sy) > TAP_MOVE) {
        l.moved = true
        if (!l.holding) clearTimeout(l.timer)
      }
      const s = this.sensitivity() * 0.35
      this.t.touchLook(dx * s, dy * s)
    }
    if (handled) e.preventDefault()
  }

  private onEnd = (e: TouchEvent) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier === this.stickId) {
        this.stickId = null
        this.knob.style.transform = ''
        this.t.touchMove(0, 0, false)
        continue
      }
      const l = this.looks.get(touch.identifier)
      if (!l) continue
      clearTimeout(l.timer)
      if (l.holding) this.t.touchBreak(false)
      else if (!l.moved && performance.now() - l.t < HOLD_MS) this.t.touchUse()
      this.looks.delete(touch.identifier)
    }
  }
}
