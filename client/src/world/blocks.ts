// Block state registry for one game version (from public/data/<version>/blocks.json).

export interface BlockDef {
  index: number
  name: string
  min: number
  max: number
  def: number
  props: [string, string[]][]
  transparent: boolean
  emit: number
  filter: number
  hardness: number
  material: string
  needsTool: boolean
  shape: number | number[]
}

export type Box = [number, number, number, number, number, number]

export class BlockRegistry {
  blocks: BlockDef[] = []
  byName = new Map<string, BlockDef>()
  stateBlock: Uint16Array
  totalStates: number
  globalBits: number
  private shapes: Record<string, Box[]>
  private propCache = new Map<number, Record<string, string>>()
  airLike: Uint8Array

  constructor(data: { blocks: any[]; shapes: Record<string, Box[]> }) {
    this.shapes = data.shapes
    let maxState = 0
    data.blocks.forEach((b, i) => {
      const d: BlockDef = {
        index: i, name: b.n, min: b.min, max: b.max, def: b.def, props: b.p,
        transparent: !!b.tr, emit: b.em, filter: b.fl, hardness: b.h, material: b.m ?? 'default', needsTool: !!b.rt, shape: b.s
      }
      this.blocks.push(d)
      this.byName.set(d.name, d)
      maxState = Math.max(maxState, d.max)
    })
    this.totalStates = maxState + 1
    this.globalBits = Math.ceil(Math.log2(this.totalStates))
    this.stateBlock = new Uint16Array(this.totalStates)
    this.airLike = new Uint8Array(this.totalStates)
    for (const b of this.blocks) {
      for (let s = b.min; s <= b.max; s++) this.stateBlock[s] = b.index
      if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') for (let s = b.min; s <= b.max; s++) this.airLike[s] = 1
    }
  }

  block(state: number): BlockDef {
    return this.blocks[this.stateBlock[state] ?? 0]
  }

  name(state: number): string {
    return this.block(state).name
  }

  isAir(state: number): boolean {
    return this.airLike[state] === 1
  }

  props(state: number): Record<string, string> {
    let p = this.propCache.get(state)
    if (p) return p
    const b = this.block(state)
    p = {}
    let data = state - b.min
    for (let i = b.props.length - 1; i >= 0; i--) {
      const [name, values] = b.props[i]
      p[name] = values[data % values.length]
      data = Math.floor(data / values.length)
    }
    this.propCache.set(state, p)
    return p
  }

  /** State id for a block with some properties set (others default). */
  stateFor(name: string, props: Record<string, string> = {}): number {
    const b = this.byName.get(name)
    if (!b) return 0
    const cur = { ...this.props(b.def), ...props }
    let idx = 0
    for (const [pn, values] of b.props) idx = idx * values.length + Math.max(0, values.indexOf(cur[pn]))
    return b.min + idx
  }

  collision(state: number): Box[] {
    const b = this.block(state)
    const s = Array.isArray(b.shape) ? b.shape[state - b.min] ?? b.shape[0] : b.shape
    return this.shapes[String(s)] ?? []
  }
}
