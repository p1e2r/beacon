import { Codec } from './codec'
import { BlockRegistry } from '../world/blocks'
import type { EntityType } from '../render/entities'

export interface VersionInfo { version: string; protocol: number }
export interface VersionData {
  info: VersionInfo
  codec: Codec
  blocks: BlockRegistry
  entities: EntityType[]
  items: { id: number; n: string; d: string }[]
}

const base = new URL('./data/', document.baseURI).href
let index: VersionInfo[] | null = null
const loaded = new Map<string, Promise<VersionData>>()
let lang: Promise<Record<string, string>> | null = null

async function json(path: string) {
  const r = await fetch(base + path)
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`)
  return r.json()
}

export async function versions(): Promise<VersionInfo[]> {
  index ??= await json('versions.json')
  return index!
}

export async function latest(): Promise<VersionInfo> {
  const v = await versions()
  return v[v.length - 1]
}

/**
 * Version used for the first status ping. 26.2's packets are checked against Mojang's
 * own packet report, so we offer that first; ViaVersion servers echo the client's
 * protocol back, so they then let us in as 26.2 too.
 */
export async function pingVersion(): Promise<VersionInfo> {
  const v = await versions()
  return v.find(x => x.version === '26.2') ?? v[v.length - 1]
}

/** Picks the data for a server's protocol; unknown protocols use the newest 26.x. */
export async function forProtocol(protocol: number): Promise<{ info: VersionInfo; exact: boolean }> {
  const v = await versions()
  const hit = v.find(x => x.protocol === protocol)
  return hit ? { info: hit, exact: true } : { info: v[v.length - 1], exact: false }
}

export function load(info: VersionInfo): Promise<VersionData> {
  let p = loaded.get(info.version)
  if (!p) {
    p = (async () => {
      const [protocol, blocks, entities, items] = await Promise.all([
        json(`${info.version}/protocol.json`), json(`${info.version}/blocks.json`), json(`${info.version}/entities.json`), json(`${info.version}/items.json`)
      ])
      return { info, codec: new Codec(protocol), blocks: new BlockRegistry(blocks), entities, items }
    })()
    loaded.set(info.version, p)
    p.catch(() => loaded.delete(info.version))
  }
  return p
}

export function language(): Promise<Record<string, string>> {
  lang ??= json('lang.json').catch(() => ({}))
  return lang
}
