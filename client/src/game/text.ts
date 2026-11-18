// Minecraft text components (JSON or NBT-simplified) → DOM, plain text.

let LANG: Record<string, string> = {}
export function setLanguage(l: Record<string, string>) {
  LANG = l
}

const NAMED: Record<string, string> = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA', dark_red: '#AA0000', dark_purple: '#AA00AA',
  gold: '#FFAA00', gray: '#AAAAAA', dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF', red: '#FF5555',
  light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
}
const CODES: Record<string, string> = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red', '5': 'dark_purple', '6': 'gold', '7': 'gray',
  '8': 'dark_gray', '9': 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
}

interface Style {
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

export type Component = any

/** Normalises NBT quirks: {"": value} wrappers, byte booleans, lists. */
function norm(c: Component): Component {
  if (c == null) return ''
  if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return String(c)
  if (Array.isArray(c)) return { text: '', extra: c }
  if (typeof c === 'object' && Object.keys(c).length === 1 && '' in c) return norm(c[''])
  return c
}

function translate(key: string, args: Component[], fallback?: string): Component[] {
  const fmt = LANG[key] ?? fallback ?? key
  const out: Component[] = []
  let i = 0, auto = 0
  const re = /%(?:(\d+)\$)?([sd%])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fmt))) {
    if (m.index > i) out.push(fmt.slice(i, m.index))
    if (m[2] === '%') out.push('%')
    else {
      const idx = m[1] ? Number(m[1]) - 1 : auto++
      out.push(args[idx] ?? '')
    }
    i = re.lastIndex
  }
  if (i < fmt.length) out.push(fmt.slice(i))
  return out
}

function walk(c: Component, style: Style, emit: (text: string, s: Style) => void) {
  c = norm(c)
  if (typeof c === 'string') return legacy(c, style, emit)
  const s: Style = { ...style }
  if (c.color) s.color = c.color.startsWith('#') ? c.color : NAMED[c.color] ?? s.color
  for (const k of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const) if (c[k] !== undefined) s[k] = c[k] === true || c[k] === 1 || c[k] === 'true'
  if (c.text !== undefined) legacy(String(c.text), s, emit)
  else if (c.translate !== undefined) for (const part of translate(c.translate, (c.with ?? []).map(norm), c.fallback)) walk(part, s, emit)
  else if (c.keybind) emit(String(c.keybind).replace('key.', ''), s)
  else if (c.score) emit(String(c.score.value ?? ''), s)
  else if (c.selector) emit(String(c.selector), s)
  if (Array.isArray(c.extra)) for (const e of c.extra) walk(e, s, emit)
}

// "§a" legacy formatting codes inside text
function legacy(t: string, style: Style, emit: (text: string, s: Style) => void) {
  if (!t.includes('§')) return emit(t, style)
  let s = { ...style }
  const parts = t.split('§')
  if (parts[0]) emit(parts[0], s)
  for (let i = 1; i < parts.length; i++) {
    const code = parts[i][0]?.toLowerCase()
    const rest = parts[i].slice(1)
    if (code in CODES) s = { color: NAMED[CODES[code]] }
    else if (code === 'l') s = { ...s, bold: true }
    else if (code === 'o') s = { ...s, italic: true }
    else if (code === 'n') s = { ...s, underlined: true }
    else if (code === 'm') s = { ...s, strikethrough: true }
    else if (code === 'k') s = { ...s, obfuscated: true }
    else if (code === 'r') s = { ...style }
    if (rest) emit(rest, s)
  }
}

export function toPlain(c: Component): string {
  let out = ''
  walk(c, {}, t => (out += t))
  return out
}

export function toDom(c: Component, base: Style = {}): HTMLSpanElement {
  const root = document.createElement('span')
  walk(c, base, (t, s) => {
    if (!t) return
    const span = document.createElement('span')
    span.textContent = s.obfuscated ? t.replace(/\S/g, '▒') : t
    if (s.color) span.style.color = s.color
    if (s.bold) span.style.fontWeight = '700'
    if (s.italic) span.style.fontStyle = 'italic'
    const deco = [s.underlined && 'underline', s.strikethrough && 'line-through'].filter(Boolean).join(' ')
    if (deco) span.style.textDecoration = deco
    root.appendChild(span)
  })
  return root
}

export const tr = (key: string, ...args: Component[]) => ({ translate: key, with: args })
