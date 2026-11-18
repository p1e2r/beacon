// Settings, server list and the loaded texture pack, kept in this browser.

export interface Settings {
  username: string
  proxy: string
  key: string
  viewDistance: number
  fov: number
  sensitivity: number
}

export interface ServerEntry {
  id: string
  name: string
  address: string // host or host:port
}

const S = 'beacon.settings', L = 'beacon.servers'

function read<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k)
    return v ? { ...d, ...JSON.parse(v) } : d
  } catch {
    return d
  }
}

export function loadSettings(): Settings {
  return read<Settings>(S, { username: '', proxy: '', key: '', viewDistance: 8, fov: 70, sensitivity: 1 })
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(S, JSON.stringify(s)) } catch {}
}

export function loadServers(): ServerEntry[] {
  try {
    const v = localStorage.getItem(L)
    return v ? JSON.parse(v) : []
  } catch {
    return []
  }
}
export function saveServers(l: ServerEntry[]) {
  try { localStorage.setItem(L, JSON.stringify(l)) } catch {}
}

export function parseAddress(a: string): { host: string; port?: number } {
  a = a.trim()
  const v6 = a.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : undefined }
  const m = a.match(/^([^:]+)(?::(\d+))?$/)
  if (m) return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : undefined }
  return { host: a }
}

// ---- texture pack in IndexedDB

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('beacon', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('files')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

export async function savePack(name: string, bytes: Uint8Array) {
  const d = await db()
  await new Promise<void>((res, rej) => {
    const t = d.transaction('files', 'readwrite')
    t.objectStore('files').put({ name, bytes }, 'pack')
    t.oncomplete = () => res()
    t.onerror = () => rej(t.error)
  })
}

export async function loadPack(): Promise<{ name: string; bytes: Uint8Array } | null> {
  try {
    const d = await db()
    return await new Promise(res => {
      const r = d.transaction('files').objectStore('files').get('pack')
      r.onsuccess = () => res(r.result ?? null)
      r.onerror = () => res(null)
    })
  } catch {
    return null
  }
}

export async function clearPack() {
  const d = await db()
  d.transaction('files', 'readwrite').objectStore('files').delete('pack')
}
