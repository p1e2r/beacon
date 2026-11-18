// Builds vertex arrays for one 16×16×16 section.
import { BlockAssets, Dir, DIR_VEC, Layer, Baked, tintColor } from './assets'
import { World } from '../world/world'

export interface MeshData {
  pos: Float32Array
  uv: Float32Array
  color: Float32Array
  light: Float32Array
  index: Uint32Array
}

class Builder {
  pos: number[] = []
  uv: number[] = []
  color: number[] = []
  light: number[] = []
  index: number[] = []
  count = 0
  quad(p: ArrayLike<number>, ox: number, oy: number, oz: number, uv: ArrayLike<number>, r: number, g: number, b: number, ao: number[] | null, sky: number, block: number, flip: boolean) {
    const base = this.count
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i * 3] + ox, p[i * 3 + 1] + oy, p[i * 3 + 2] + oz)
      this.uv.push(uv[i * 2], uv[i * 2 + 1])
      const a = ao ? ao[i] : 1
      this.color.push(r * a, g * a, b * a)
      this.light.push(sky, block)
    }
    if (flip) this.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base)
    else this.index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.count += 4
  }
  build(): MeshData | null {
    if (!this.count) return null
    return {
      pos: new Float32Array(this.pos), uv: new Float32Array(this.uv), color: new Float32Array(this.color),
      light: new Float32Array(this.light), index: new Uint32Array(this.index)
    }
  }
}

const SHADE = [0.5, 1, 0.8, 0.8, 0.6, 0.6]
const AO_CURVE = [0.45, 0.62, 0.8, 1]
const tintCache = new Map<number, [number, number, number]>()

export function meshSection(world: World, assets: BlockAssets, cx: number, sy: number, cz: number): MeshData[] | null {
  const col = world.column(cx, cz)
  const sec = col?.sections[sy]
  if (!sec) return null
  const reg = world.reg
  const baked = assets.baked
  const layers = [new Builder(), new Builder(), new Builder()]
  const bx0 = cx * 16, by0 = world.minY + sy * 16, bz0 = cz * 16

  // fast neighbour lookup inside the section, world lookup at the border
  const stateAt = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < 16 && ly >= 0 && ly < 16 && lz >= 0 && lz < 16) return sec[(ly << 8) | (lz << 4) | lx]
    return world.getState(bx0 + lx, by0 + ly, bz0 + lz)
  }
  const occl = (lx: number, ly: number, lz: number) => baked[stateAt(lx, ly, lz)]?.occludes ? 1 : 0

  const tintOf = (state: number, name: string): [number, number, number] => {
    let t = tintCache.get(state)
    if (!t) {
      const c = tintColor(name, reg.props(state))
      t = [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
      tintCache.set(state, t)
    }
    return t
  }

  for (let i = 0; i < 4096; i++) {
    const state = sec[i]
    if (state === 0) continue
    const b: Baked | undefined = baked[state]
    if (!b || (b.invisible && !b.fluid)) continue
    const lx = i & 15, lz = (i >> 4) & 15, ly = i >> 8
    const wx = bx0 + lx, wy = by0 + ly, wz = bz0 + lz
    let name: string | null = null

    for (const q of b.quads) {
      if (q.cull >= 0) {
        const v = DIR_VEC[q.cull]
        const ns = stateAt(lx + v[0], ly + v[1], lz + v[2])
        const nb = baked[ns]
        if (nb?.occludes) continue
        if (ns === state && q.layer !== Layer.Solid) continue
      }
      let r = 1, g = 1, bl = 1
      if (q.tint === -2) {
        r = ((b.color >> 16) & 255) / 255; g = ((b.color >> 8) & 255) / 255; bl = (b.color & 255) / 255
      } else if (q.tint >= 0) {
        name ??= reg.name(state)
        ;[r, g, bl] = tintOf(state, name)
      }
      const s = q.shade ? SHADE[q.normal] : 1
      r *= s; g *= s; bl *= s
      const nv = DIR_VEC[q.normal]
      let [sky, blk] = world.light(wx + (q.edge ? nv[0] : 0), wy + (q.edge ? nv[1] : 0), wz + (q.edge ? nv[2] : 0))
      if (!q.edge) {
        const [s2, b2] = world.light(wx + nv[0], wy + nv[1], wz + nv[2])
        sky = Math.max(sky, s2); blk = Math.max(blk, b2)
      }
      let ao: number[] | null = null
      let flip = false
      if (q.edge && q.layer !== Layer.Translucent) {
        ao = vertexAo(q.pos, q.normal, lx, ly, lz, occl)
        flip = ao[0] + ao[2] < ao[1] + ao[3]
      }
      layers[q.layer].quad(q.pos, lx, ly, lz, q.uv, r, g, bl, ao, sky / 15, blk / 15, flip)
    }

    if (b.fluid) addFluid(layers, assets, world, stateAt, b, state, lx, ly, lz, wx, wy, wz)
  }
  return layers.map(l => l.build()) as MeshData[]
}

function vertexAo(pos: Float32Array, d: Dir, lx: number, ly: number, lz: number, occl: (x: number, y: number, z: number) => number): number[] {
  const n = DIR_VEC[d]
  const axis = d < 2 ? 1 : d < 4 ? 2 : 0
  const a = axis === 0 ? 1 : 0, b = axis === 2 ? 1 : 2
  const out = [1, 1, 1, 1]
  const px = lx + n[0], py = ly + n[1], pz = lz + n[2]
  for (let i = 0; i < 4; i++) {
    const va = pos[i * 3 + a], vb = pos[i * 3 + b]
    if ((va > 1e-3 && va < 1 - 1e-3) || (vb > 1e-3 && vb < 1 - 1e-3)) continue
    const sa = va < 0.5 ? -1 : 1, sb = vb < 0.5 ? -1 : 1
    const off = (ax: number, s: number) => [ax === 0 ? s : 0, ax === 1 ? s : 0, ax === 2 ? s : 0]
    const oa = off(a, sa), ob = off(b, sb)
    const s1 = occl(px + oa[0], py + oa[1], pz + oa[2])
    const s2 = occl(px + ob[0], py + ob[1], pz + ob[2])
    const c = occl(px + oa[0] + ob[0], py + oa[1] + ob[1], pz + oa[2] + ob[2])
    out[i] = AO_CURVE[s1 && s2 ? 0 : 3 - (s1 + s2 + c)]
  }
  return out
}

function fluidHeight(assets: BlockAssets, world: World, state: number): number {
  const p = world.reg.props(state)
  const level = p.level !== undefined ? Number(p.level) : 0
  if (level >= 8) return 1
  return level === 0 ? 0.875 : Math.max(0.1, (8 - level) / 9)
}

function addFluid(layers: Builder[], assets: BlockAssets, world: World, stateAt: (x: number, y: number, z: number) => number,
  b: Baked, state: number, lx: number, ly: number, lz: number, wx: number, wy: number, wz: number) {
  const water = b.fluid === 1
  const above = stateAt(lx, ly + 1, lz)
  const same = (s: number) => assets.baked[s]?.fluid === b.fluid
  const h = same(above) ? 1 : fluidHeight(assets, world, state)
  const tex = water ? 'block/water_still' : 'block/lava_still'
  const r = assets.atlas.rect(assets.atlas.slots.has(tex) ? tex : '$white', 0, 0, 16, 16)
  const uv = [r[0], r[1], r[0], r[3], r[2], r[3], r[2], r[1]]
  let cr = 1, cg = 1, cb = 1
  if (water) { cr = 0x3f / 255; cg = 0x76 / 255; cb = 0xe4 / 255 }
  else if (!assets.textured) { cr = 0.85; cg = 0.35; cb = 0.06 }
  if (!assets.textured && water) { cr *= 1.1; cg *= 1.1 }
  const layer = water ? layers[Layer.Translucent] : layers[Layer.Solid]
  const [sky, blk] = world.light(wx, wy + 1, wz)
  const lightB = water ? blk : 15
  const faces: [Dir, number[]][] = [
    [Dir.Up, [0, h, 0, 0, h, 1, 1, h, 1, 1, h, 0]],
    [Dir.Down, [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1]],
    [Dir.North, [1, h, 0, 1, 0, 0, 0, 0, 0, 0, h, 0]],
    [Dir.South, [0, h, 1, 0, 0, 1, 1, 0, 1, 1, h, 1]],
    [Dir.West, [0, h, 0, 0, 0, 0, 0, 0, 1, 0, h, 1]],
    [Dir.East, [1, h, 1, 1, 0, 1, 1, 0, 0, 1, h, 0]]
  ]
  for (const [d, p] of faces) {
    const v = DIR_VEC[d]
    const ns = stateAt(lx + v[0], ly + v[1], lz + v[2])
    if (same(ns)) continue
    if (assets.baked[ns]?.occludes) continue
    if (d === Dir.Up && h >= 1) continue
    const s = SHADE[d]
    layer.quad(p, lx, ly, lz, uv, cr * s, cg * s, cb * s, null, sky / 15, lightB / 15, false)
  }
}
