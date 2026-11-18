// Packet (de)serialisation driven by minecraft-data's protocol.json for the server's version.
import { Buffer } from 'buffer'
import * as protodefNs from 'protodef'
import * as nbtNs from 'prismarine-nbt'
import * as mcTypesNs from 'minecraft-protocol/src/datatypes/compiler-minecraft.js'

const unwrap = (m: any) => (m && m.default ? m.default : m)
const protodef = unwrap(protodefNs)
const nbt = unwrap(nbtNs)
const mcTypes = unwrap(mcTypesNs)

export type State = 'handshaking' | 'status' | 'login' | 'configuration' | 'play'
export type Direction = 'toServer' | 'toClient'

export interface Packet {
  name: string
  params: any
}

export class Codec {
  private cache = new Map<string, any>()

  constructor(private protocol: any) {}

  private proto(state: State, dir: Direction) {
    const key = state + dir
    let p = this.cache.get(key)
    if (!p) {
      const compiler = new protodef.Compiler.ProtoDefCompiler()
      compiler.addTypes(mcTypes)
      compiler.addProtocol(this.protocol, [state, dir])
      nbt.addTypesToCompiler('big', compiler)
      p = compiler.compileProtoDefSync()
      this.cache.set(key, p)
    }
    return p
  }

  encode(state: State, name: string, params: any): Uint8Array {
    const buf: Buffer = this.proto(state, 'toServer').createPacketBuffer('packet', { name, params })
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  decode(state: State, data: Uint8Array): Packet {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const res = this.proto(state, 'toClient').parsePacketBuffer('packet', buf)
    return res.data
  }

  /** Packet id → name for a direction, so we can skip unknown packets cheaply. */
  names(state: State, dir: Direction): Record<number, string> {
    const t = this.protocol[state][dir].types.packet[1][0].type[1].mappings as Record<string, string>
    const out: Record<number, string> = {}
    for (const [k, v] of Object.entries(t)) out[parseInt(k, 16)] = v
    return out
  }
}

export const simplifyNbt = (v: any) => (v == null ? v : nbt.simplify(v))

// ---- VarInt helpers for framing -------------------------------------------------------

export function readVarInt(b: Uint8Array, pos: number): [value: number, next: number] | null {
  let v = 0
  for (let i = 0; i < 5; i++) {
    if (pos >= b.length) return null
    const byte = b[pos++]
    v |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return [v, pos]
  }
  throw new Error('VarInt too long')
}

export function varIntBytes(v: number): number[] {
  const out: number[] = []
  v >>>= 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}
