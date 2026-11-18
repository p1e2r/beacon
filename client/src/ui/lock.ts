// Pointer lock where the browser has it (desktop); a no-op on phones and tablets.

export const isTouch =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
  window.matchMedia?.('(pointer: coarse)').matches

export const canLock = typeof document !== 'undefined' && typeof (HTMLElement.prototype as any).requestPointerLock === 'function' && !isTouch

export function lock(el: HTMLElement | null) {
  if (!el || !canLock) return
  try {
    const r: any = el.requestPointerLock()
    r?.catch?.(() => {})
  } catch {}
}

export function unlock() {
  try {
    if (document.pointerLockElement) document.exitPointerLock?.()
  } catch {}
}

export function isLocked(el: HTMLElement) {
  return canLock && document.pointerLockElement === el
}

/** Fullscreen + landscape on phones that allow it (Android Chrome). iOS ignores this. */
export function goFullscreen() {
  if (!isTouch) return
  const d = document.documentElement as any
  try {
    const p = (d.requestFullscreen ?? d.webkitRequestFullscreen)?.call(d, { navigationUI: 'hide' })
    Promise.resolve(p).then(() => (screen.orientation as any)?.lock?.('landscape')).catch(() => {})
  } catch {}
}
