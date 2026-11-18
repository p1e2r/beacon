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
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  // phones: shorter render distance by default
  return read<Settings>(S, { username: '', proxy: '', key: '', viewDistance: touch ? 5 : 8, fov: 70, sensitivity: 1 })
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

export interface StoredPack {
  id: string
  name: string
  bytes: Uint8Array
}

/** Texture packs, highest priority first (index 0 is the top of the list). */
export async function loadPacks(): Promise<StoredPack[]> {
  try {
    const d = await db()
    const get = (k: string) => new Promise<any>(res => {
      const r = d.transaction('files').objectStore('files').get(k)
      r.onsuccess = () => res(r.result ?? null)
      r.onerror = () => res(null)
    })
    const list = await get('packs')
    if (Array.isArray(list)) return list
    // v1.0 kept a single pack
    const old = await get('pack')
    if (old?.bytes) {
      const migrated = [{ id: Math.random().toString(36).slice(2), name: old.name, bytes: old.bytes }]
      await savePacks(migrated)
      return migrated
    }
    return []
  } catch {
    return []
  }
}

export async function savePacks(list: StoredPack[]) {
  const d = await db()
  await new Promise<void>((res, rej) => {
    const t = d.transaction('files', 'readwrite')
    t.objectStore('files').put(list, 'packs')
    t.objectStore('files').delete('pack')
    t.oncomplete = () => res()
    t.onerror = () => rej(t.error)
  })
}
