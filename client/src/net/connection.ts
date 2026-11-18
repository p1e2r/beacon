// Minecraft connection: framing, compression, and the handshake → login → configuration
// → play flow (offline mode). Play packets are handed to the game.
import { unzlibSync, zlibSync } from 'fflate'
import { Codec, State, readVarInt, varIntBytes, simplifyNbt } from './codec'
import { Transport } from './transport'
import { offlineUuid } from './md5'

export interface ConnectOptions {
  host: string
  port: number
  username: string
  protocol: number
  viewDistance: number
}

/** Play packets the game cares about. Others are skipped without decoding. */
const PLAY_HANDLED = new Set([
  'login', 'respawn', 'position', 'player_rotation', 'map_chunk', 'unload_chunk', 'update_light', 'block_change',
  'multi_block_change', 'chunk_batch_start', 'chunk_batch_finished', 'keep_alive', 'ping', 'kick_disconnect',
  'system_chat', 'player_chat', 'profileless_chat', 'action_bar', 'set_title_text', 'set_title_subtitle', 'set_title_time', 'clear_titles',
  'update_health', 'experience', 'game_state_change', 'abilities', 'update_time', 'spawn_entity', 'entity_destroy', 'rel_entity_move',
  'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_teleport', 'sync_entity_position', 'entity_metadata', 'player_info', 'player_remove',
  'set_slot', 'window_items', 'held_item_slot', 'set_player_inventory', 'open_window', 'close_window', 'update_view_position', 'acknowledge_player_digging',
  'start_configuration', 'add_resource_pack', 'remove_resource_pack', 'playerlist_header', 'spawn_position', 'set_cursor_item',
  'entity_velocity', 'cookie_request', 'transfer', 'animation', 'death_combat_event', 'block_break_animation', 'server_data', 'show_dialog'
])

export class Connection {
  state: State = 'handshaking'
  private threshold = -1
  private buf: Uint8Array = new Uint8Array(0)
  private names: Record<State, Record<number, string>> = {} as any
  onPlay: (name: string, p: any) => void = () => {}
  onLoginSuccess: (p: any) => void = () => {}
  onConfigEnd: () => void = () => {}
  onDisconnect: (reason: any) => void = () => {}
  onCodeOfConduct: (text: string) => Promise<boolean> = async () => true
  onRegistry: (id: string, entries: { key: string; value: any }[]) => void = () => {}
  onResourcePack: (p: any) => number = () => 3
  private closed = false
  private brandSent = false

  constructor(private tr: Transport, public codec: Codec, private opts: ConnectOptions) {
    for (const s of ['login', 'configuration', 'play', 'status'] as State[]) this.names[s] = codec.names(s, 'toClient')
    tr.onData = b => this.feed(b)
    tr.onClose = reason => this.disconnect({ text: reason })
  }

  start() {
    this.state = 'handshaking'
    this.send('set_protocol', { protocolVersion: this.opts.protocol, serverHost: this.opts.host, serverPort: this.opts.port, nextState: 2 })
    this.state = 'login'
    this.send('login_start', { username: this.opts.username, playerUUID: offlineUuid(this.opts.username) })
  }

  close() {
    this.closed = true
    this.tr.close()
  }

  private disconnect(reason: any) {
    if (this.closed) return
    this.closed = true
    this.tr.close()
    this.onDisconnect(reason)
  }

  send(name: string, params: any) {
    if (this.closed) return
    let body: Uint8Array
    try {
      body = this.codec.encode(this.state, name, params)
    } catch (e) {
      console.warn('encode failed', this.state, name, params, e)
      return
    }
    let frame: Uint8Array
    if (this.threshold >= 0) {
      let inner: Uint8Array, dataLen: number[]
      if (body.length >= this.threshold) {
        inner = zlibSync(body, { level: 4 })
        dataLen = varIntBytes(body.length)
      } else {
        inner = body
        dataLen = [0]
      }
      const len = varIntBytes(dataLen.length + inner.length)
      frame = new Uint8Array(len.length + dataLen.length + inner.length)
      frame.set(len, 0)
      frame.set(dataLen, len.length)
      frame.set(inner, len.length + dataLen.length)
    } else {
      const len = varIntBytes(body.length)
      frame = new Uint8Array(len.length + body.length)
      frame.set(len, 0)
      frame.set(body, len.length)
    }
    this.tr.send(frame)
  }

  private feed(chunk: Uint8Array) {
    if (this.buf.length === 0) this.buf = chunk
    else {
      const n = new Uint8Array(this.buf.length + chunk.length)
      n.set(this.buf)
      n.set(chunk, this.buf.length)
      this.buf = n
    }
    let pos = 0
    while (!this.closed) {
      const h = readVarInt(this.buf, pos)
      if (!h) break
      const [len, start] = h
      if (start + len > this.buf.length) break
      let body = this.buf.subarray(start, start + len)
      pos = start + len
      if (this.threshold >= 0) {
        const d = readVarInt(body, 0)!
        body = d[0] === 0 ? body.subarray(d[1]) : unzlibSync(body.subarray(d[1]))
      }
      this.handle(body)
    }
    this.buf = pos >= this.buf.length ? new Uint8Array(0) : this.buf.slice(pos)
  }

  private handle(body: Uint8Array) {
    const id = readVarInt(body, 0)![0]
    const name = this.names[this.state]?.[id]
    if (!name) return
    if (this.state === 'play' && !PLAY_HANDLED.has(name)) return
    let p: any
    try {
      p = this.codec.decode(this.state, body).params
    } catch (e) {
      console.warn(`Could not read ${this.state}/${name}`, e)
      if (name === 'kick_disconnect' || name === 'disconnect') this.disconnect({ text: 'Disconnected (unreadable reason)' })
      return
    }
    switch (this.state) {
      case 'login': return this.login(name, p)
      case 'configuration': return this.config(name, p)
      case 'play':
        if (name === 'keep_alive') return this.send('keep_alive', { keepAliveId: p.keepAliveId })
        if (name === 'ping') return this.send('pong', { id: p.id })
        if (name === 'kick_disconnect') return this.disconnect(simplifyNbt(p.reason))
        if (name === 'start_configuration') {
          this.send('configuration_acknowledged', {})
          this.state = 'configuration'
          return
        }
        if (name === 'cookie_request') return this.send('cookie_response', { key: p.cookie, value: undefined })
        return this.onPlay(name, p)
    }
  }

  private login(name: string, p: any) {
    switch (name) {
      case 'compress':
        this.threshold = p.threshold
        return
      case 'disconnect':
        return this.disconnect(typeof p.reason === 'string' ? safeJson(p.reason) : simplifyNbt(p.reason))
      case 'encryption_begin':
        return this.disconnect({
          text: 'This server is in online mode (premium accounts only). Beacon can only join offline-mode servers.'
        })
      case 'login_plugin_request':
        return this.send('login_plugin_response', { messageId: p.messageId, data: undefined })
      case 'cookie_request':
        return this.send('cookie_response', { key: p.cookie, value: undefined })
      case 'success':
        this.send('login_acknowledged', {})
        this.state = 'configuration'
        this.onLoginSuccess(p)
        this.sendClientInfo()
        return
    }
  }

  sendClientInfo() {
    const settings = {
      locale: 'en_us', viewDistance: this.opts.viewDistance, chatFlags: 0, chatColors: true, skinParts: 0x7f,
      mainHand: 1, enableTextFiltering: false, enableServerListing: true, particleStatus: 'all'
    }
    this.send('settings', settings)
    if (!this.brandSent && this.state === 'configuration') {
      this.brandSent = true
      const brand = new TextEncoder().encode('beacon')
      const data = new Uint8Array([...varIntBytes(brand.length), ...brand])
      this.send('custom_payload', { channel: 'minecraft:brand', data: toBuffer(data) })
    }
  }

  private async config(name: string, p: any) {
    switch (name) {
      case 'keep_alive': return this.send('keep_alive', { keepAliveId: p.keepAliveId })
      case 'ping': return this.send('pong', { id: p.id })
      case 'disconnect': return this.disconnect(simplifyNbt(p.reason))
      case 'select_known_packs':
        // Claim no packs, so the server sends full registry data (dimension heights etc.).
        return this.send('select_known_packs', { packs: [] })
      case 'registry_data':
        return this.onRegistry(p.id, p.entries.map((e: any) => ({ key: e.key, value: e.value ? simplifyNbt(e.value) : null })))
      case 'add_resource_pack': {
        const result = this.onResourcePack(p)
        for (const r of result === 3 ? [3, 4, 0] : [result]) this.send('resource_pack_receive', { uuid: p.uuid, result: r })
        return
      }
      case 'cookie_request': return this.send('cookie_response', { key: p.cookie, value: undefined })
      case 'code_of_conduct': {
        const ok = await this.onCodeOfConduct(p.contents)
        if (ok) this.send('accept_code_of_conduct', {})
        else this.disconnect({ text: 'You declined the server rules.' })
        return
      }
      case 'finish_configuration':
        this.send('finish_configuration', {})
        this.state = 'play'
        this.onConfigEnd()
        return
    }
  }
}

function safeJson(s: string) {
  try { return JSON.parse(s) } catch { return { text: s } }
}

function toBuffer(u: Uint8Array) {
  // protodef wants a Buffer for raw data fields
  const B = (globalThis as any).Buffer
  return B ? B.from(u) : u
}

/** Server list ping: returns the status JSON and the round-trip time. */
export async function pingServer(tr: Transport, codec: Codec, host: string, port: number, protocol: number): Promise<{ status: any; ms: number }> {
  return new Promise((resolve, reject) => {
    let buf = new Uint8Array(0)
    let status: any = null
    let sentAt = 0
    const names = codec.names('status', 'toClient')
    const frame = (state: State, name: string, params: any) => {
      const body = codec.encode(state, name, params)
      const len = varIntBytes(body.length)
      const f = new Uint8Array(len.length + body.length)
      f.set(len)
      f.set(body, len.length)
      tr.send(f)
    }
    const timer = setTimeout(() => { tr.close(); reject(new Error('The server did not answer.')) }, 10000)
    tr.onClose = reason => { clearTimeout(timer); if (status) resolve({ status, ms: -1 }); else reject(new Error(reason)) }
    tr.onData = chunk => {
      const n = new Uint8Array(buf.length + chunk.length)
      n.set(buf); n.set(chunk, buf.length); buf = n
      for (;;) {
        const h = readVarInt(buf, 0)
        if (!h || h[1] + h[0] > buf.length) return
        const body = buf.subarray(h[1], h[1] + h[0])
        buf = buf.slice(h[1] + h[0])
        const id = readVarInt(body, 0)![0]
        const p = codec.decode('status', body).params
        if (names[id] === 'server_info') {
          status = safeJson(p.response)
          sentAt = performance.now()
          frame('status', 'ping', { time: [0, 1] })
        } else if (names[id] === 'ping') {
          clearTimeout(timer)
          resolve({ status, ms: Math.round(performance.now() - sentAt) })
          tr.close()
          return
        }
      }
    }
    frame('handshaking', 'set_protocol', { protocolVersion: protocol, serverHost: host, serverPort: port, nextState: 1 })
    frame('status', 'ping_start', {})
  })
}
