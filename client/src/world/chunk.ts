// Chunk column storage and the 26.x chunk section wire format.
//
// Section: i16 nonAirBlocks, i16 fluidCount (26.1+), block states container, biome container.
// Paletted container: u8 bits; 0 → one VarInt value; small → VarInt palette + packed longs;
// large → global ids. Since 1.21.5 there is no length prefix before the longs: the count
// follows from the bit width. Values never span two longs; the lowest bits come first.

export class Reader {
  pos = 0
  private dv: DataView
  constructor(public b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  u8() { return this.b[this.pos++] }
  i16() { const v = this.dv.getInt16(this.pos); this.pos += 2; return v }
  varint() {
    let v = 0
    for (let i = 0; i < 5; i++) {
      const byte = this.b[this.pos++]
      v |= (byte & 0x7f) << (7 * i)
      if ((byte & 0x80) === 0) return v
    }
    throw new Error('VarInt too long')
  }
  get left() { return this.b.length - this.pos }
}

function readContainer(r: Reader, entries: number, minBits: number, maxPaletteBits: number, globalBits: number, out: Uint16Array | null): number {
  let bits = r.u8()
  if (bits === 0) {
    const v = r.varint()
    if (out) out.fill(v)
    return v
  }
  let palette: number[] | null = null
  if (bits <= maxPaletteBits) {
    bits = Math.max(bits, minBits)
    const n = r.varint()
    palette = new Array(n)
    for (let i = 0; i < n; i++) palette[i] = r.varint()
  } else {
    bits = globalBits
  }
  const perLong = Math.floor(64 / bits)
  const longs = Math.ceil(entries / perLong)
  const mask = (1 << bits) - 1
  let idx = 0
  for (let l = 0; l < longs; l++) {
    // two 32-bit halves, big-endian on the wire
    const p = r.pos
    const hi = ((r.b[p] << 24) | (r.b[p + 1] << 16) | (r.b[p + 2] << 8) | r.b[p + 3]) >>> 0
    const lo = ((r.b[p + 4] << 24) | (r.b[p + 5] << 16) | (r.b[p + 6] << 8) | r.b[p + 7]) >>> 0
    r.pos += 8
    if (!out) continue
    for (let j = 0; j < perLong && idx < entries; j++, idx++) {
      const bit = j * bits
      let v: number
      if (bit + bits <= 32) v = (lo >>> bit) & mask
      else if (bit >= 32) v = (hi >>> (bit - 32)) & mask
      else v = ((lo >>> bit) | (hi << (32 - bit))) & mask
      out[idx] = palette ? palette[v] ?? 0 : v
    }
  }
  return -1
}

export class Column {
  /** Block states per section, null = all air. Index: (y << 8) | (z << 4) | x */
  sections: (Uint16Array | null)[]
  /** Light per section, with one extra section below and above. Nibbles, 2048 bytes. */
  sky: (Uint8Array | null)[]
  blockLight: (Uint8Array | null)[]
  constructor(public x: number, public z: number, public count: number) {
    this.sections = new Array(count).fill(null)
    this.sky = new Array(count + 2).fill(null)
    this.blockLight = new Array(count + 2).fill(null)
  }
}

export function parseColumn(x: number, z: number, data: Uint8Array, sectionCount: number, globalBits: number, biomeBits: number, isAir: (s: number) => boolean): Column {
  const col = new Column(x, z, sectionCount)
  const r = new Reader(data)
  for (let s = 0; s < sectionCount && r.left > 0; s++) {
    const nonAir = r.i16()
    const fluids = r.i16() // fluid count (26.1+)
    const states = new Uint16Array(4096)
    const single = readContainer(r, 4096, 4, 8, globalBits, states)
    readContainer(r, 64, 1, 3, biomeBits, null)
    if ((single >= 0 && isAir(single)) || (nonAir === 0 && fluids === 0)) continue
    col.sections[s] = states
  }
  return col
}

export const DARK = new Uint8Array(2048)

/** Fills light arrays from map_chunk / update_light data. */
export function applyLight(col: Column, p: any) {
  const apply = (mask: any[], empty: any[], arrays: number[][], target: (Uint8Array | null)[]) => {
    const bits = maskBits(mask)
    const emptyBits = maskBits(empty)
    let k = 0
    for (let i = 0; i < target.length; i++) {
      if (bits(i)) {
        const a = arrays[k++]
        if (a) target[i] = a instanceof Uint8Array ? a : Uint8Array.from(a)
      } else if (emptyBits(i)) target[i] = DARK
    }
  }
  apply(p.skyLightMask, p.emptySkyLightMask, p.skyLight, col.sky)
  apply(p.blockLightMask, p.emptyBlockLightMask, p.blockLight, col.blockLight)
}

// protodef reads i64 as [hi, lo] (or a BigInt-like array); turn it into a bit test.
function maskBits(longs: any[]): (i: number) => boolean {
  const words: number[] = []
  for (const l of longs ?? []) {
    let hi = 0, lo = 0
    if (Array.isArray(l)) { hi = l[0] >>> 0; lo = l[1] >>> 0 }
    else if (typeof l === 'bigint') { hi = Number((l >> 32n) & 0xffffffffn); lo = Number(l & 0xffffffffn) }
    else if (typeof l === 'number') { lo = l >>> 0 }
    else if (l && typeof l.valueOf === 'function') { const b = BigInt(l.valueOf()); hi = Number((b >> 32n) & 0xffffffffn); lo = Number(b & 0xffffffffn) }
    words.push(lo, hi)
  }
  return i => {
    const w = words[i >> 5]
    return w !== undefined && ((w >>> (i & 31)) & 1) === 1
  }
}
