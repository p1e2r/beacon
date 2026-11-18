import { BlockRegistry } from './blocks'
import { Column } from './chunk'

export const key = (x: number, z: number) => `${x},${z}`

export class World {
  columns = new Map<string, Column>()
  /** Sections that need a new mesh: "cx,sy,cz" (sy = section index from minY). */
  dirty = new Set<string>()
  minY = -64
  height = 384
  constructor(public reg: BlockRegistry) {}

  get sectionCount() {
    return this.height >> 4
  }

  setDimension(minY: number, height: number) {
    this.minY = minY
    this.height = height
    this.columns.clear()
    this.dirty.clear()
  }

  column(cx: number, cz: number) {
    return this.columns.get(key(cx, cz))
  }

  addColumn(col: Column) {
    this.columns.set(key(col.x, col.z), col)
    for (let s = 0; s < this.sectionCount; s++) {
      this.markSection(col.x, s, col.z)
    }
    // neighbours may now cull faces against this column
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.column(col.x + dx, col.z + dz)
      if (n) for (let s = 0; s < this.sectionCount; s++) if (n.sections[s]) this.markSection(n.x, s, n.z)
    }
  }

  removeColumn(cx: number, cz: number) {
    this.columns.delete(key(cx, cz))
  }

  markSection(cx: number, sy: number, cz: number) {
    if (sy < 0 || sy >= this.sectionCount) return
    this.dirty.add(`${cx},${sy},${cz}`)
  }

  getState(x: number, y: number, z: number): number {
    const sy = (y - this.minY) >> 4
    if (sy < 0 || sy >= this.sectionCount) return 0
    const col = this.columns.get(key(x >> 4, z >> 4))
    if (!col) return 0
    const sec = col.sections[sy]
    if (!sec) return 0
    return sec[(((y - this.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)]
  }

  /** Whether the column for this block position is loaded. */
  loaded(x: number, z: number) {
    return this.columns.has(key(x >> 4, z >> 4))
  }

  setState(x: number, y: number, z: number, state: number) {
    const sy = (y - this.minY) >> 4
    if (sy < 0 || sy >= this.sectionCount) return
    const col = this.columns.get(key(x >> 4, z >> 4))
    if (!col) return
    let sec = col.sections[sy]
    if (!sec) {
      if (this.reg.isAir(state)) return
      sec = col.sections[sy] = new Uint16Array(4096)
    }
    sec[(((y - this.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)] = state
    const cx = x >> 4, cz = z >> 4
    this.markSection(cx, sy, cz)
    const lx = x & 15, lz = z & 15, ly = (y - this.minY) & 15
    if (lx === 0) this.markSection(cx - 1, sy, cz)
    if (lx === 15) this.markSection(cx + 1, sy, cz)
    if (lz === 0) this.markSection(cx, sy, cz - 1)
    if (lz === 15) this.markSection(cx, sy, cz + 1)
    if (ly === 0) this.markSection(cx, sy - 1, cz)
    if (ly === 15) this.markSection(cx, sy + 1, cz)
  }

  /** Light 0..15 at a block: max(sky * daylight, block). */
  light(x: number, y: number, z: number): [sky: number, block: number] {
    const col = this.columns.get(key(x >> 4, z >> 4))
    const ls = ((y - this.minY) >> 4) + 1
    if (!col || ls < 0 || ls >= col.sky.length) return [15, 0]
    const i = (((y - this.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)
    const sky = col.sky[ls]
    const bl = col.blockLight[ls]
    const sv = sky ? (sky[i >> 1] >> ((i & 1) * 4)) & 15 : 15
    const bv = bl ? (bl[i >> 1] >> ((i & 1) * 4)) & 15 : 0
    return [sv, bv]
  }
}
