// Turns a Minecraft client .jar or resource pack .zip into a texture atlas and per-state
// baked block models. Without a pack, blocks are drawn from their collision shapes in
// flat colours (see fallbackColor).
import { unzipSync } from 'fflate'
import { BlockRegistry } from '../world/blocks'

export const enum Dir { Down, Up, North, South, West, East }
export const DIR_VEC: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const DIR_NAMES = ['down', 'up', 'north', 'south', 'west', 'east']
export const enum Layer { Solid, Cutout, Translucent }

export interface Quad {
  pos: Float32Array // 4 vertices × xyz, block space 0..1
  uv: Float32Array // 4 × uv (atlas)
  normal: Dir // facing after rotation (for shading / light lookup)
  cull: number // Dir or -1
  tint: number // -1 none
  shade: boolean
  layer: Layer
  /** face lies on the block boundary (eligible for ambient occlusion) */
  edge: boolean
}

export interface Baked {
  quads: Quad[]
  /** Hides neighbour faces completely (full opaque cube). */
  occludes: boolean
  fluid: 0 | 1 | 2 // none, water, lava
  invisible: boolean
  /** colour used for particles / map / fallback */
  color: number
}

type Json = any

export class Pack {
  files: Record<string, Uint8Array>
  name: string
  constructor(files: Record<string, Uint8Array>, name: string) {
    this.files = files
    this.name = name
  }
  static fromZip(bytes: Uint8Array, name: string) {
    const files = unzipSync(bytes, {
      filter: f => f.name.startsWith('assets/minecraft/') && (f.name.endsWith('.png') || f.name.endsWith('.json') || f.name.endsWith('.mcmeta'))
    })
    const keys = Object.keys(files)
    if (!keys.some(k => k.startsWith('assets/minecraft/textures/block/'))) throw new Error('No block textures found in that file. Pick a Minecraft .jar or a resource pack .zip.')
    return new Pack(files, name)
  }
  json(path: string): Json | null {
    const f = this.files[path]
    if (!f) return null
    try {
      return JSON.parse(new TextDecoder().decode(f))
    } catch {
      return null
    }
  }
  has(path: string) {
    return path in this.files
  }
}

const strip = (n: string) => n.replace(/^minecraft:/, '')

// ---------------------------------------------------------------------------------------
// Texture atlas

export class Atlas {
  canvas: HTMLCanvasElement
  tile: number
  cols: number
  size: number
  slots = new Map<string, number>()
  alpha = new Map<string, Layer>()
  private ctx: CanvasRenderingContext2D
  constructor(count: number, tile: number) {
    this.tile = tile
    this.cols = Math.ceil(Math.sqrt(count + 1))
    let size = 1
    while (size < this.cols * tile) size *= 2
    this.size = size
    this.cols = Math.floor(size / tile)
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = size
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    this.ctx.imageSmoothingEnabled = false
    // slot 0: white (flat colour / fallback)
    this.ctx.fillStyle = '#fff'
    this.ctx.fillRect(0, 0, tile, tile)
    this.slots.set('$white', 0)
    this.alpha.set('$white', Layer.Solid)
  }
  add(name: string, img: CanvasImageSource & { width: number; height: number }) {
    const i = this.slots.size
    const x = (i % this.cols) * this.tile, y = Math.floor(i / this.cols) * this.tile
    const w = img.width
    // animated textures are vertical strips: use the first frame
    this.ctx.drawImage(img, 0, 0, w, Math.min(w, img.height), x, y, this.tile, this.tile)
    const d = this.ctx.getImageData(x, y, this.tile, this.tile).data
    let layer = Layer.Solid
    for (let p = 3; p < d.length; p += 4) {
      if (d[p] === 0) layer = Math.max(layer, Layer.Cutout)
      else if (d[p] < 250) { layer = Layer.Translucent; break }
    }
    this.slots.set(name, i)
    this.alpha.set(name, layer)
  }
  /** Atlas UV rect for a texture and a 0..16 sub-rectangle. */
  rect(name: string, u1: number, v1: number, u2: number, v2: number): [number, number, number, number] {
    const i = this.slots.get(name) ?? 0
    const x = (i % this.cols) * this.tile, y = Math.floor(i / this.cols) * this.tile
    const s = this.tile / 16 / this.size
    const inset = 0.02 / this.size
    const fx = x / this.size, fy = y / this.size
    const a = fx + u1 * s, b = fy + v1 * s, c = fx + u2 * s, d = fy + v2 * s
    // shrink slightly towards the centre to avoid bleeding from neighbours
    const sx = a < c ? inset : -inset, sy = b < d ? inset : -inset
    return [a + sx, b + sy, c - sx, d - sy]
  }
}

async function decodePng(bytes: Uint8Array): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------
// Models

interface Element {
  from: number[]
  to: number[]
  rotation?: { origin: number[]; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean }
  shade?: boolean
  faces: Record<string, { uv?: number[]; texture: string; cullface?: string; rotation?: number; tintindex?: number }>
}

interface ResolvedModel {
  elements: Element[]
  textures: Record<string, string>
}

class ModelResolver {
  private cache = new Map<string, ResolvedModel | null>()
  forcedTranslucent = new Set<string>()
  constructor(private pack: Pack) {}
  get(name: string): ResolvedModel | null {
    name = strip(name)
    if (this.cache.has(name)) return this.cache.get(name)!
    this.cache.set(name, null)
    let textures: Record<string, string> = {}
    let elements: Element[] | null = null
    let cur: string | null = name
    for (let depth = 0; cur && depth < 20; depth++) {
      const m: Json = this.pack.json(`assets/minecraft/models/${strip(cur)}.json`)
      if (!m) break
      const own: Record<string, string> = {}
      for (const [k, v] of Object.entries<any>(m.textures || {})) {
        // 26.x: a texture can be { sprite, force_translucent }
        if (typeof v === 'string') own[k] = v
        else if (v && typeof v.sprite === 'string') {
          own[k] = v.sprite
          if (v.force_translucent) this.forcedTranslucent.add(strip(v.sprite))
        }
      }
      textures = { ...own, ...textures }
      if (!elements && Array.isArray(m.elements)) elements = m.elements
      cur = m.parent ? strip(m.parent) : null
    }
    const res = { elements: elements || [], textures }
    this.cache.set(name, res)
    return res
  }
  texture(model: ResolvedModel, ref: string): string | null {
    let t = ref
    for (let i = 0; i < 10 && typeof t === 'string' && t.startsWith('#'); i++) t = model.textures[t.slice(1)]
    return typeof t === 'string' && !t.startsWith('#') ? strip(t) : null
  }
}

function matchesWhen(when: Json, props: Record<string, string>): boolean {
  if (!when) return true
  if (when.OR) return when.OR.some((w: Json) => matchesWhen(w, props))
  if (when.AND) return when.AND.every((w: Json) => matchesWhen(w, props))
  return Object.entries(when).every(([k, v]) => String(v).split('|').includes(props[k]))
}

function matchesVariant(key: string, props: Record<string, string>) {
  if (key === '' || key === 'normal') return true
  return key.split(',').every(kv => {
    const [k, v] = kv.split('=')
    return props[k] === v
  })
}

// rotate a point (0..16 space) by variant rotation, x first then y
function rotX(p: number[], steps: number) {
  for (let i = 0; i < steps; i++) { const y = p[1], z = p[2]; p[1] = z; p[2] = 16 - y }
}
function rotY(p: number[], steps: number) {
  for (let i = 0; i < steps; i++) { const x = p[0], z = p[2]; p[0] = 16 - z; p[2] = x }
}
function rotDir(d: Dir, xs: number, ys: number): Dir {
  const v = [...DIR_VEC[d]].map(n => n * 8 + 8)
  rotX(v, xs)
  rotY(v, ys)
  const n = v.map(c => Math.round((c - 8) / 8))
  return DIR_VEC.findIndex(dv => dv[0] === n[0] && dv[1] === n[1] && dv[2] === n[2]) as Dir
}

// vertices of each face: [top-left, bottom-left, bottom-right, top-right] in texture space
function faceCorners(d: Dir, f: number[], t: number[]): number[][] {
  const [x1, y1, z1] = f, [x2, y2, z2] = t
  switch (d) {
    case Dir.Up: return [[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]]
    case Dir.Down: return [[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]]
    case Dir.North: return [[x2, y2, z1], [x2, y1, z1], [x1, y1, z1], [x1, y2, z1]]
    case Dir.South: return [[x1, y2, z2], [x1, y1, z2], [x2, y1, z2], [x2, y2, z2]]
    case Dir.West: return [[x1, y2, z1], [x1, y1, z1], [x1, y1, z2], [x1, y2, z2]]
    case Dir.East: return [[x2, y2, z2], [x2, y1, z2], [x2, y1, z1], [x2, y2, z1]]
  }
}
function defaultUv(d: Dir, f: number[], t: number[]): number[] {
  const [x1, y1, z1] = f, [x2, y2, z2] = t
  switch (d) {
    case Dir.Up: return [x1, z1, x2, z2]
    case Dir.Down: return [x1, 16 - z2, x2, 16 - z1]
    case Dir.North: return [16 - x2, 16 - y2, 16 - x1, 16 - y1]
    case Dir.South: return [x1, 16 - y2, x2, 16 - y1]
    case Dir.West: return [z1, 16 - y2, z2, 16 - y1]
    case Dir.East: return [16 - z2, 16 - y2, 16 - z1, 16 - y1]
  }
}

function rotateAround(p: number[], r: NonNullable<Element['rotation']>) {
  const a = (r.angle * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a)
  const o = r.origin
  const x = p[0] - o[0], y = p[1] - o[1], z = p[2] - o[2]
  let scale = 1
  if (r.rescale && Math.abs(c) > 1e-4) scale = 1 / Math.abs(c)
  if (r.axis === 'y') { p[0] = o[0] + (x * c + z * s) * (r.rescale ? scale : 1); p[2] = o[2] + (-x * s + z * c) * (r.rescale ? scale : 1) }
  else if (r.axis === 'x') { p[1] = o[1] + (y * c - z * s) * (r.rescale ? scale : 1); p[2] = o[2] + (y * s + z * c) * (r.rescale ? scale : 1) }
  else { p[0] = o[0] + (x * c - y * s) * (r.rescale ? scale : 1); p[1] = o[1] + (x * s + y * c) * (r.rescale ? scale : 1) }
}

function normalOf(v: number[][]): Dir {
  const ax = v[1][0] - v[0][0], ay = v[1][1] - v[0][1], az = v[1][2] - v[0][2]
  const bx = v[2][0] - v[0][0], by = v[2][1] - v[0][1], bz = v[2][2] - v[0][2]
  // tl→bl × tl→br points outwards for our corner order
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
  const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))
  if (m === Math.abs(ny)) return ny > 0 ? Dir.Up : Dir.Down
  if (m === Math.abs(nx)) return nx > 0 ? Dir.East : Dir.West
  return nz > 0 ? Dir.South : Dir.North
}

// ---------------------------------------------------------------------------------------

const INVISIBLE = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void', 'moving_piston'])
const TRANSLUCENT_HINT = /glass|ice|slime|honey_block|nether_portal|water|bubble_column/

export class BlockAssets {
  atlas!: Atlas
  baked: Baked[] = []
  textured = false
  itemTextures = new Map<string, string>() // item name -> texture name

  constructor(private reg: BlockRegistry) {}

  async build(pack: Pack | null, onProgress: (s: string) => void = () => {}) {
    if (!pack) return this.buildFallback()
    this.textured = true
    const models = new ModelResolver(pack)
    // 1. resolve every state to a list of (model, x, y, uvlock)
    type Part = { model: ResolvedModel; x: number; y: number }
    const parts: Part[][] = new Array(this.reg.totalStates)
    const needed = new Set<string>()
    const bsCache = new Map<string, Json>()
    for (const b of this.reg.blocks) {
      let bs = bsCache.get(b.name)
      if (bs === undefined) {
        bs = pack.json(`assets/minecraft/blockstates/${b.name}.json`)
        bsCache.set(b.name, bs)
      }
      for (let s = b.min; s <= b.max; s++) {
        const props = this.reg.props(s)
        const list: Part[] = []
        const push = (v: Json) => {
          const one = Array.isArray(v) ? v[0] : v
          if (typeof one?.model !== 'string') return
          const m = models.get(one.model)
          if (m) list.push({ model: m, x: ((one.x || 0) / 90) & 3, y: ((one.y || 0) / 90) & 3 })
        }
        if (bs?.variants) {
          for (const [k, v] of Object.entries(bs.variants)) if (matchesVariant(k, props)) { push(v); break }
        } else if (bs?.multipart) {
          for (const part of bs.multipart) if (matchesWhen(part.when, props)) push(part.apply)
        }
        parts[s] = list
        for (const p of list) {
          for (const e of p.model.elements) for (const f of Object.values(e.faces)) {
            const t = models.texture(p.model, f.texture)
            if (t) needed.add(t)
          }
          const particle = models.texture(p.model, '#particle')
          if (particle) needed.add(particle)
        }
      }
    }
    for (const t of ['block/water_still', 'block/water_flow', 'block/lava_still', 'block/lava_flow']) needed.add(t)
    // item icons for the hotbar
    for (const path of Object.keys(pack.files)) {
      const m = path.match(/^assets\/minecraft\/textures\/item\/([a-z0-9_]+)\.png$/)
      if (m) { needed.add('item/' + m[1]); this.itemTextures.set(m[1], 'item/' + m[1]) }
    }

    // 2. atlas
    onProgress(`Loading ${needed.size} textures…`)
    const imgs = new Map<string, ImageBitmap>()
    let tile = 16
    const list = [...needed]
    await Promise.all(list.map(async t => {
      const bytes = pack.files[`assets/minecraft/textures/${t}.png`]
      if (!bytes) return
      const img = await decodePng(bytes)
      if (img) { imgs.set(t, img); tile = Math.max(tile, Math.min(64, img.width)) }
    }))
    this.atlas = new Atlas(imgs.size, tile)
    for (const t of list) { const img = imgs.get(t); if (img) this.atlas.add(t, img) }

    // 3. bake
    onProgress('Building block models…')
    this.baked = new Array(this.reg.totalStates)
    const bakeCache = new Map<string, Baked>()
    for (const b of this.reg.blocks) {
      for (let s = b.min; s <= b.max; s++) {
        const ps = parts[s]
        const fluid = this.fluidOf(s)
        const cacheKey = ps.map(p => `${(p.model as any).__id ??= Math.random()}:${p.x}:${p.y}`).join('|') + ':' + b.name + ':' + fluid
        let baked = bakeCache.get(cacheKey)
        if (!baked) {
          baked = this.bake(b.name, ps, models, fluid)
          bakeCache.set(cacheKey, baked)
        }
        this.baked[s] = baked
      }
    }
  }

  private bake(name: string, ps: { model: ResolvedModel; x: number; y: number }[], models: ModelResolver, fluid: 0 | 1 | 2): Baked {
    const quads: Quad[] = []
    let fullFaces = 0
    let anyTransparent = false
    let color = 0x888888
    for (const p of ps) {
      for (const e of p.model.elements) {
        for (const [fname, f] of Object.entries(e.faces)) {
          const d = DIR_NAMES.indexOf(fname) as Dir
          if (d < 0) continue
          const tex = models.texture(p.model, f.texture)
          if (!tex) continue
          const corners = faceCorners(d, e.from, e.to).map(c => [...c])
          if (e.rotation && e.rotation.angle) for (const c of corners) rotateAround(c, e.rotation)
          for (const c of corners) { rotX(c, p.x); rotY(c, p.y) }
          const uv = f.uv ?? defaultUv(d, e.from, e.to)
          const r = this.atlas.rect(tex, uv[0], uv[1], uv[2], uv[3])
          const uvc = [[r[0], r[1]], [r[0], r[3]], [r[2], r[3]], [r[2], r[1]]]
          const rot = (((f.rotation || 0) / 90) & 3)
          const pos = new Float32Array(12), uvs = new Float32Array(8)
          for (let i = 0; i < 4; i++) {
            pos[i * 3] = corners[i][0] / 16; pos[i * 3 + 1] = corners[i][1] / 16; pos[i * 3 + 2] = corners[i][2] / 16
            const u = uvc[(i + rot) % 4]
            uvs[i * 2] = u[0]; uvs[i * 2 + 1] = u[1]
          }
          const layerT = models.forcedTranslucent.has(tex) ? Layer.Translucent : this.atlas.alpha.get(tex) ?? Layer.Solid
          const layer = layerT === Layer.Translucent && !TRANSLUCENT_HINT.test(name) ? Layer.Cutout : layerT
          if (layer !== Layer.Solid) anyTransparent = true
          const normal = normalOf(corners)
          const cull = f.cullface ? rotDir(DIR_NAMES.indexOf(f.cullface === 'bottom' ? 'down' : f.cullface) as Dir, p.x, p.y) : -1
          const isEdge = isOnEdge(pos, normal)
          if (isEdge && isFullFace(pos, normal) && layer === Layer.Solid) fullFaces |= 1 << normal
          quads.push({ pos, uv: uvs, normal, cull, tint: f.tintindex ?? -1, shade: e.shade !== false, layer, edge: isEdge })
        }
      }
    }
    if (ps.length) {
      const pt = models.texture(ps[0].model, '#particle')
      if (pt) color = 0x888888
    }
    const occludes = fullFaces === 0b111111 && !anyTransparent
    return { quads, occludes, fluid, invisible: INVISIBLE.has(name) || (quads.length === 0 && !fluid), color }
  }

  private buildFallback() {
    this.textured = false
    this.atlas = new Atlas(0, 16)
    this.baked = new Array(this.reg.totalStates)
    const cache = new Map<string, Baked>()
    for (const b of this.reg.blocks) {
      for (let s = b.min; s <= b.max; s++) {
        const boxes = this.reg.collision(s)
        const fluid = this.fluidOf(s)
        const k = b.name + JSON.stringify(boxes) + fluid
        let baked = cache.get(k)
        if (!baked) {
          const color = fallbackColor(b.name)
          const quads: Quad[] = []
          const r = this.atlas.rect('$white', 0, 0, 16, 16)
          const uvc = [[r[0], r[1]], [r[0], r[3]], [r[2], r[3]], [r[2], r[1]]]
          let full = false
          const use = boxes.length ? boxes : PLANT.test(b.name) ? [[0.3, 0, 0.3, 0.7, 0.7, 0.7]] : []
          for (const bx of use) {
            const f = [bx[0] * 16, bx[1] * 16, bx[2] * 16], t = [bx[3] * 16, Math.min(16, bx[4] * 16), bx[5] * 16]
            if (f[0] === 0 && f[1] === 0 && f[2] === 0 && t[0] === 16 && t[1] === 16 && t[2] === 16) full = true
            for (let d = 0 as Dir; d < 6; d++) {
              const corners = faceCorners(d, f, t)
              const pos = new Float32Array(12), uvs = new Float32Array(8)
              for (let i = 0; i < 4; i++) {
                pos.set(corners[i].map(c => c / 16), i * 3)
                uvs.set(uvc[i], i * 2)
              }
              const edge = isOnEdge(pos, d)
              quads.push({ pos, uv: uvs, normal: d, cull: edge ? d : -1, tint: -2, shade: true, layer: Layer.Solid, edge })
            }
          }
          const invisible = INVISIBLE.has(b.name) || (quads.length === 0 && !fluid)
          baked = { quads, occludes: full && boxes.length === 1 && !b.transparent, fluid, invisible, color }
          cache.set(k, baked)
        }
        this.baked[s] = baked
      }
    }
  }

  fluidOf(s: number): 0 | 1 | 2 {
    const name = this.reg.name(s)
    if (name === 'water' || name === 'bubble_column' || name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass') return 1
    if (name === 'lava') return 2
    return this.reg.props(s).waterlogged === 'true' ? 1 : 0
  }

  /** Average colour of an item/block texture for UI swatches, or a fallback colour. */
  iconFor(item: string): { tex: string | null; color: number } {
    const tex = this.itemTextures.get(item) ?? (this.atlas.slots.has('block/' + item) ? 'block/' + item : null)
    return { tex, color: fallbackColor(item) }
  }
}

const PLANT = /flower|grass|fern|sapling|tulip|orchid|allium|bluet|daisy|poppy|dandelion|rose|mushroom|bush|vine|sugar_cane|kelp|seagrass|wheat|carrots|potatoes|beetroots|torch|lantern|sign|button|lever|rail|redstone_wire|pressure_plate/

function isOnEdge(pos: Float32Array, d: Dir): boolean {
  const axis = d < 2 ? 1 : d < 4 ? 2 : 0
  const want = d === Dir.Down || d === Dir.North || d === Dir.West ? 0 : 1
  for (let i = 0; i < 4; i++) if (Math.abs(pos[i * 3 + axis] - want) > 1e-4) return false
  return true
}
function isFullFace(pos: Float32Array, d: Dir): boolean {
  const axis = d < 2 ? 1 : d < 4 ? 2 : 0
  const others = [0, 1, 2].filter(a => a !== axis)
  for (const a of others) {
    let mn = 1, mx = 0
    for (let i = 0; i < 4; i++) { mn = Math.min(mn, pos[i * 3 + a]); mx = Math.max(mx, pos[i * 3 + a]) }
    if (mn > 1e-4 || mx < 1 - 1e-4) return false
  }
  return true
}

/** Biome-independent tints (grass, foliage, water…) for tintindex faces. */
export function tintColor(name: string, props: Record<string, string>): number {
  if (name === 'water' || name === 'bubble_column' || name === 'water_cauldron') return 0x3f76e4
  if (name === 'spruce_leaves') return 0x619961
  if (name === 'birch_leaves') return 0x80a755
  if (name.endsWith('_leaves') || name === 'vine' || name === 'cocoa') return name === 'cherry_leaves' || name === 'azalea_leaves' || name === 'flowering_azalea_leaves' ? 0xffffff : 0x59ae30
  if (name === 'lily_pad') return 0x208030
  if (name === 'redstone_wire') {
    const p = Number(props.power || 0)
    const f = p / 15
    const r = Math.round((f * 0.6 + (f > 0 ? 0.4 : 0.3)) * 255)
    return (r << 16) | (Math.round(Math.max(0, f * f * 0.7 - 0.5) * 255) << 8) | Math.round(Math.max(0, f * f * 0.6 - 0.7) * 255)
  }
  if (name === 'melon_stem' || name === 'pumpkin_stem') return 0x60b030
  if (name.includes('stem')) return 0xe0c71c
  return 0x7cbd6b // grass
}

const COLORS: [RegExp, number][] = [
  [/^grass_block$/, 0x6da544], [/short_grass|tall_grass|fern|vine|_leaves|azalea|moss/, 0x4f8f2c], [/^dirt|coarse_dirt|rooted_dirt|farmland|dirt_path/, 0x87603f],
  [/podzol/, 0x5b3f1c], [/mycelium/, 0x6f6265], [/sand$|sandstone/, 0xdbcf9c], [/red_sand/, 0xb5622a], [/gravel/, 0x837c7a],
  [/^stone$|stone_bricks|cobblestone|andesite|stone_slab|stone_stairs|smooth_stone/, 0x7d7d7d], [/deepslate|tuff|basalt|blackstone/, 0x4a4a50], [/diorite|calcite|quartz/, 0xd9d6cf],
  [/granite/, 0x9c6b56], [/bedrock/, 0x3a3a3a], [/obsidian/, 0x1b1427], [/_log$|_wood$|_stem$|_hyphae$/, 0x6b5132], [/planks|_slab|_stairs|_fence|_door|_trapdoor|crafting_table|bookshelf|chest|barrel/, 0xa8864f],
  [/water|bubble/, 0x3f76e4], [/lava|magma/, 0xd9590f], [/snow|powder_snow/, 0xf2f7f7], [/ice/, 0x9ec2f6], [/clay/, 0xa0a6b3],
  [/coal_ore/, 0x5d5d5d], [/iron/, 0xd8af93], [/gold/, 0xf6d23d], [/diamond/, 0x5be1d6], [/emerald/, 0x3bc35d], [/redstone/, 0xb51b0a], [/lapis/, 0x2c57b0], [/copper/, 0xc06d4d],
  [/netherrack|nether_brick|crimson/, 0x6f2e2e], [/warped/, 0x2b6b62], [/soul_sand|soul_soil/, 0x51402f], [/glowstone|shroomlight|lantern|torch|sea_lantern/, 0xf1d07c],
  [/end_stone|purpur/, 0xddde9f], [/terracotta/, 0x985e43], [/white_/, 0xe9ecec], [/orange_/, 0xf07613], [/magenta_/, 0xbd44b3], [/light_blue_/, 0x3aafd9],
  [/yellow_/, 0xf8c527], [/lime_/, 0x70b919], [/pink_/, 0xed8dac], [/light_gray_/, 0x8e8e86], [/gray_/, 0x3e4447], [/cyan_/, 0x158991], [/purple_/, 0x792aac],
  [/blue_/, 0x35399d], [/brown_/, 0x724728], [/green_/, 0x546d1b], [/red_|poppy|rose/, 0xa12722], [/black_/, 0x141519], [/glass/, 0xc0dce6], [/flower|tulip|orchid|allium|daisy|dandelion/, 0xd8c53a],
  [/pumpkin/, 0xc57414], [/melon/, 0x6f9a1d], [/hay|wheat/, 0xc9a42a], [/sugar_cane|cactus|kelp|seagrass|bamboo/, 0x5a8d2c], [/mushroom/, 0xa3825f], [/rail/, 0x8b7963]
]
export function fallbackColor(name: string): number {
  for (const [re, c] of COLORS) if (re.test(name)) return c
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const g = 90 + (Math.abs(h) % 80)
  return (g << 16) | ((g - 5) << 8) | (g - 12)
}
