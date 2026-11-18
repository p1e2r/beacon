// One play session: wires the connection to the world, renderer, player and HUD.
import { Connection } from '../net/connection'
import { simplifyNbt } from '../net/codec'
import { VersionData } from '../net/versions'
import { Transport } from '../net/transport'
import { World } from '../world/world'
import { parseColumn, applyLight } from '../world/chunk'
import { Renderer } from '../render/renderer'
import { BlockAssets, DIR_VEC } from '../render/assets'
import { Entities, rayBox } from '../render/entities'
import { Player, Input } from './player'
import { Hud, Slot } from '../ui/hud'
import { toPlain, tr } from './text'
import { Buffer } from 'buffer'

export interface SessionOptions {
  host: string
  port: number
  username: string
  viewDistance: number
  fov: number
  sensitivity: number
}

interface RegistryEntry { key: string; value: any }

const TOOL_TIER: Record<string, number> = { wooden: 2, stone: 4, copper: 5, iron: 6, diamond: 8, netherite: 9, golden: 12 }

export class Session {
  conn: Connection
  world: World
  player = new Player()
  entities: Entities
  registries = new Map<string, RegistryEntry[]>()
  entityId = -1
  dimension = 'minecraft:overworld'
  gamemode = 0
  loaded = false
  dead = false
  health = 20
  food = 20
  dayTime = 6000
  inventory: Slot[] = new Array(46).fill(null)
  container: { id: number; title: string; slots: Slot[] } | null = null
  selected = 0
  sequence = 1
  players = new Map<string, { name: string; gamemode: number; latency: number; listed: boolean; display: any }>()
  tabHeader: any = ''
  tabFooter: any = ''
  private keys = new Set<string>()
  private mouse = { left: false, right: false }
  private lastSent = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, ground: false, ticks: 0 }
  private lastInputs = ''
  private lastSprint = false
  private lastFlying = false
  private tickTimer = 0
  private raf = 0
  private lastFrame = performance.now()
  private accumulator = 0
  private dig: { x: number; y: number; z: number; face: number; ticks: number; needed: number } | null = null
  private placeCooldown = 0
  private attackCooldown = 0
  private lastSpace = 0
  private pendingAcks = 0
  private fps = 0
  private frames = 0
  private fpsAt = performance.now()
  private target: { x: number; y: number; z: number; face: number; hit: number[] } | null = null
  private closed = false
  onEnd: (reason: any, transfer?: { host: string; port: number }) => void = () => {}

  constructor(tr: Transport, public data: VersionData, public renderer: Renderer, public assets: BlockAssets, public hud: Hud, public opts: SessionOptions) {
    this.world = renderer.world
    this.entities = new Entities(renderer.entities, data.entities)
    this.conn = new Connection(tr, data.codec, { host: opts.host, port: opts.port, username: opts.username, protocol: data.info.protocol, viewDistance: opts.viewDistance })
    this.conn.onRegistry = (id, entries) => this.registries.set(id.replace(/^minecraft:/, ''), entries)
    this.conn.onDisconnect = reason => this.end(reason)
    this.conn.onPlay = (n, p) => this.onPacket(n, p)
    this.conn.onCodeOfConduct = text => this.hud.confirm('Server rules', text, 'Accept', 'Decline')
    this.conn.onResourcePack = p => {
      if (p.forced) this.hud.toast('This server wants a resource pack; Beacon pretends it loaded it.')
      return 3
    }
    this.conn.onLoginSuccess = () => this.hud.status('Joining…')
    this.renderer.viewDistance = opts.viewDistance
    this.renderer.camera.fov = opts.fov
    this.renderer.camera.updateProjectionMatrix()
    this.hud.onChatSend = msg => this.sendChat(msg)
    this.hud.onRespawn = () => this.conn.send('client_command', { actionId: 'perform_respawn' })
    this.hud.onCloseContainer = () => this.closeContainer()
    this.bindInput()
    this.conn.start()
    this.loop()
  }

  // ------------------------------------------------------------------ packets

  private dimType(index: number, name: string): { minY: number; height: number } {
    const reg = this.registries.get('dimension_type') ?? []
    const v = reg[index]?.value
    if (v && typeof v.min_y === 'number') return { minY: v.min_y, height: v.height }
    if (name.includes('nether') || name.includes('end')) return { minY: 0, height: 256 }
    return { minY: -64, height: 384 }
  }

  private biomeBits() {
    const n = this.registries.get('worldgen/biome')?.length ?? 64
    return Math.ceil(Math.log2(Math.max(2, n)))
  }

  private applySpawn(ws: any) {
    const name = ws.name
    const changed = name !== this.dimension || !this.loaded
    this.dimension = name
    this.gamemode = gmNum(ws.gamemode)
    if (changed) {
      const d = this.dimType(ws.dimension, name)
      this.world.setDimension(d.minY, d.height)
      this.renderer.clear()
      this.entities.clear()
    }
    this.loaded = false
    this.dead = false
    this.hud.death(null)
    this.updateGamemode()
  }

  private updateGamemode() {
    const gm = this.gamemode
    this.player.spectator = gm === 3
    if (gm === 3) this.player.flying = true
    this.hud.setGamemode(gm)
  }

  private onPacket(name: string, p: any) {
    switch (name) {
      case 'login': {
        this.entityId = p.entityId
        this.applySpawn(p.worldState)
        this.hud.status('Loading terrain…')
        return
      }
      case 'respawn':
        this.applySpawn(p.worldState)
        return
      case 'position': {
        const f = p.flags || {}
        const pl = this.player
        pl.x = f.x ? pl.x + p.x : p.x
        pl.y = f.y ? pl.y + p.y : p.y
        pl.z = f.z ? pl.z + p.z : p.z
        pl.yaw = f.yaw ? pl.yaw + p.yaw : p.yaw
        pl.pitch = f.pitch ? pl.pitch + p.pitch : p.pitch
        pl.vx = f.dx ? pl.vx + p.dx : p.dx
        pl.vy = f.dy ? pl.vy + p.dy : p.dy
        pl.vz = f.dz ? pl.vz + p.dz : p.dz
        this.conn.send('teleport_confirm', { teleportId: p.teleportId })
        this.conn.send('position_look', { x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, flags: { onGround: false, hasHorizontalCollision: false } })
        if (!this.loaded) {
          this.loaded = true
          this.conn.send('player_loaded', {})
          this.hud.status(null)
        }
        return
      }
      case 'player_rotation':
        this.player.yaw = p.relativeYaw ? this.player.yaw + p.yaw : p.yaw
        this.player.pitch = p.relativePitch ? this.player.pitch + p.pitch : p.pitch
        return
      case 'map_chunk': {
        const data: Uint8Array = p.chunkData
        try {
          const col = parseColumn(p.x, p.z, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), this.world.sectionCount, this.data.blocks.globalBits, this.biomeBits(), s => this.data.blocks.isAir(s))
          applyLight(col, p)
          this.world.addColumn(col)
        } catch (e) {
          console.warn('bad chunk', p.x, p.z, e)
        }
        return
      }
      case 'update_light': {
        const col = this.world.column(p.chunkX, p.chunkZ)
        if (!col) return
        applyLight(col, p)
        for (let s = 0; s < this.world.sectionCount; s++) if (col.sections[s]) this.world.markSection(col.x, s, col.z)
        return
      }
      case 'unload_chunk':
        this.world.removeColumn(p.chunkX, p.chunkZ)
        this.renderer.removeColumn(p.chunkX, p.chunkZ)
        return
      case 'chunk_batch_finished':
        this.conn.send('chunk_batch_received', { chunksPerTick: 20 })
        return
      case 'block_change':
        this.world.setState(p.location.x, p.location.y, p.location.z, p.type)
        return
      case 'multi_block_change': {
        const c = p.chunkCoordinates
        for (const r of p.records) {
          const state = Math.floor(r / 4096)
          const pos = r & 0xfff
          this.world.setState(c.x * 16 + ((pos >> 8) & 15), c.y * 16 + (pos & 15), c.z * 16 + ((pos >> 4) & 15), state)
        }
        return
      }
      case 'system_chat':
        if (p.isActionBar) this.hud.actionBar(simplifyNbt(p.content))
        else this.hud.chat(simplifyNbt(p.content))
        return
      case 'profileless_chat':
        this.hud.chat(this.formatChat(p.type, simplifyNbt(p.message), simplifyNbt(p.name), p.target ? simplifyNbt(p.target) : null))
        return
      case 'player_chat': {
        const content = p.unsignedChatContent ? simplifyNbt(p.unsignedChatContent) : p.plainMessage
        this.hud.chat(this.formatChat(p.type, content, simplifyNbt(p.networkName), p.networkTargetName ? simplifyNbt(p.networkTargetName) : null))
        if (p.signature) {
          if (++this.pendingAcks >= 64) {
            this.conn.send('message_acknowledgement', { count: this.pendingAcks })
            this.pendingAcks = 0
          }
        }
        return
      }
      case 'action_bar': return this.hud.actionBar(simplifyNbt(p.text))
      case 'set_title_text': return this.hud.title(simplifyNbt(p.text))
      case 'set_title_subtitle': return this.hud.subtitle(simplifyNbt(p.text))
      case 'set_title_time': return this.hud.titleTimes(p.fadeIn, p.stay, p.fadeOut)
      case 'clear_titles': return this.hud.title(null)
      case 'update_health':
        this.health = p.health
        this.food = p.food
        this.hud.setHealth(p.health, p.food)
        if (p.health <= 0 && !this.dead) {
          this.dead = true
          this.hud.death('You died!')
        }
        return
      case 'death_combat_event':
        if (p.playerId === this.entityId) { this.dead = true; this.hud.death(simplifyNbt(p.message)) }
        return
      case 'experience': return this.hud.setXp(p.level, p.experienceBar)
      case 'game_state_change':
        if (p.reason === 'change_game_mode') { this.gamemode = Math.round(p.gameMode); this.updateGamemode() }
        return
      case 'abilities':
        this.player.canFly = (p.flags & 0x04) !== 0
        this.player.flying = (p.flags & 0x02) !== 0
        this.player.flySpeed = p.flyingSpeed || 0.05
        this.player.walkSpeed = p.walkingSpeed || 0.1
        this.lastFlying = this.player.flying
        return
      case 'update_time': {
        const c = p.clockUpdates?.[0]
        if (c) this.dayTime = Number(toNum(c.totalTicks)) % 24000
        return
      }
      case 'spawn_entity': {
        const type = this.data.entities.find(t => t.id === p.type)
        const name = type?.n === 'player' ? this.players.get(normUuid(p.objectUUID))?.name ?? null : null
        this.entities.spawn(p.entityId, normUuid(p.objectUUID), p.type, p.x, p.y, p.z, (p.yaw * 360) / 256, (p.pitch * 360) / 256, name)
        return
      }
      case 'entity_destroy':
        for (const id of p.entityIds) this.entities.remove(id)
        return
      case 'rel_entity_move':
        this.entities.moveBy(p.entityId, p.dX / 4096, p.dY / 4096, p.dZ / 4096)
        return
      case 'entity_move_look': {
        this.entities.moveBy(p.entityId, p.dX / 4096, p.dY / 4096, p.dZ / 4096)
        const e = this.entities.map.get(p.entityId)
        if (e) { e.yaw = (p.yaw * 360) / 256; e.pitch = (p.pitch * 360) / 256 }
        return
      }
      case 'entity_look': {
        const e = this.entities.map.get(p.entityId)
        if (e) { e.yaw = (p.yaw * 360) / 256; e.pitch = (p.pitch * 360) / 256 }
        return
      }
      case 'entity_head_rotation': {
        const e = this.entities.map.get(p.entityId)
        if (e) e.headYaw = (p.headYaw * 360) / 256
        return
      }
      case 'entity_teleport': {
        const e = this.entities.map.get(p.entityId)
        if (!e) return
        const f = p.flags || {}
        this.entities.moveTo(p.entityId, f.x ? e.tx + p.x : p.x, f.y ? e.ty + p.y : p.y, f.z ? e.tz + p.z : p.z)
        e.yaw = f.yaw ? e.yaw + p.yaw : p.yaw
        e.pitch = f.pitch ? e.pitch + p.pitch : p.pitch
        return
      }
      case 'sync_entity_position': {
        const e = this.entities.map.get(p.entityId)
        if (!e) return
        this.entities.moveTo(p.entityId, p.x, p.y, p.z)
        e.yaw = p.yaw; e.pitch = p.pitch
        return
      }
      case 'player_info': {
        const a = p.action || {}
        for (const d of p.data) {
          const id = normUuid(d.uuid)
          let info = this.players.get(id)
          if (a.add_player) {
            info = { name: d.player?.name ?? '?', gamemode: 0, latency: 0, listed: true, display: null }
            this.players.set(id, info)
          }
          if (!info) continue
          if (a.update_game_mode) info.gamemode = d.gamemode
          if (a.update_listed) info.listed = !!d.listed
          if (a.update_latency) info.latency = d.latency
          if (a.update_display_name) info.display = d.displayName ? simplifyNbt(d.displayName) : null
        }
        this.hud.updateTab(this.players, this.tabHeader, this.tabFooter)
        return
      }
      case 'player_remove':
        for (const u of p.players) this.players.delete(normUuid(u))
        this.hud.updateTab(this.players, this.tabHeader, this.tabFooter)
        return
      case 'playerlist_header':
        this.tabHeader = simplifyNbt(p.header)
        this.tabFooter = simplifyNbt(p.footer)
        this.hud.updateTab(this.players, this.tabHeader, this.tabFooter)
        return
      case 'window_items':
        if (p.windowId === 0) { p.items.forEach((it: any, i: number) => (this.inventory[i] = this.slot(it))); this.refreshHotbar() }
        else if (this.container && p.windowId === this.container.id) { this.container.slots = p.items.map((it: any) => this.slot(it)); this.hud.showContainer(this.container.title, this.container.slots) }
        return
      case 'set_slot':
        if (p.windowId === 0) { this.inventory[p.slot] = this.slot(p.item); this.refreshHotbar() }
        else if (this.container && p.windowId === this.container.id) { this.container.slots[p.slot] = this.slot(p.item); this.hud.showContainer(this.container.title, this.container.slots) }
        return
      case 'set_player_inventory': {
        // 0-8 hotbar, 9-35 main inventory → window 0 slot numbers
        const s = p.slotId < 9 ? 36 + p.slotId : p.slotId
        this.inventory[s] = this.slot(p.contents)
        this.refreshHotbar()
        return
      }
      case 'held_item_slot':
        this.selected = p.slot
        this.refreshHotbar()
        return
      case 'open_window':
        this.container = { id: p.windowId, title: toPlain(simplifyNbt(p.windowTitle)), slots: [] }
        this.hud.showContainer(this.container.title, [])
        document.exitPointerLock()
        return
      case 'close_window':
        this.container = null
        this.hud.showContainer(null, [])
        return
      case 'add_resource_pack':
        for (const r of [3, 4, 0]) this.conn.send('resource_pack_receive', { uuid: p.uuid, result: r })
        return
      case 'transfer':
        this.end({ text: `Transferring to ${p.host}:${p.port}…` }, { host: p.host, port: p.port })
        return
      case 'show_dialog':
        this.hud.toast('The server showed a dialog that Beacon can’t display yet.')
        return
    }
  }

  private formatChat(type: any, content: any, sender: any, target: any) {
    let ct = type?.data
    if (type && type.chatType !== undefined) ct = this.registries.get('chat_type')?.[type.chatType]?.value?.chat
    else if (ct) ct = { translation_key: ct.translationKey, parameters: ct.parameters }
    const key = ct?.translation_key ?? 'chat.type.text'
    const params: string[] = ct?.parameters ?? ['sender', 'content']
    const args = params.map(p => (p === 'sender' ? sender : p === 'target' ? target ?? '' : content))
    const style = ct?.style ?? {}
    return { ...style, ...tr(key, ...args) }
  }

  private slot(it: any): Slot {
    if (!it || !it.itemCount) return null
    const item = this.data.items.find(i => i.id === it.itemId)
    if (!item) return null
    const icon = this.assets.iconFor(item.n)
    return { name: item.n, label: item.d, count: it.itemCount, tex: icon.tex, color: icon.color }
  }

  private refreshHotbar() {
    this.hud.setHotbar(this.inventory.slice(36, 45), this.selected, this.renderer.assets)
  }

  // ------------------------------------------------------------------ chat

  sendChat(msg: string) {
    msg = msg.trim()
    if (!msg) return
    if (msg.startsWith('/')) {
      this.conn.send('chat_command', { command: msg.slice(1).slice(0, 32767) })
    } else {
      this.conn.send('chat_message', {
        message: msg.slice(0, 256), timestamp: BigInt(Date.now()), salt: 0n, signature: undefined,
        offset: this.pendingAcks, acknowledged: Buffer.alloc(3), checksum: 0
      })
      this.pendingAcks = 0
    }
  }

  // ------------------------------------------------------------------ input

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.hud.typing) return
    const locked = document.pointerLockElement === this.renderer.canvas
    if (e.code === 'KeyT' || e.code === 'Enter' || e.code === 'Slash') {
      e.preventDefault()
      document.exitPointerLock()
      this.hud.openChat(e.code === 'Slash' ? '/' : '')
      this.keys.clear()
      return
    }
    if (e.code === 'Tab') { e.preventDefault(); this.hud.showTab(true); return }
    if (e.code === 'F3') { e.preventDefault(); this.hud.toggleDebug(); return }
    if (e.code === 'KeyE') {
      if (this.container) { this.closeContainer(); return }
      if (this.hud.inventoryOpen) { this.hud.showInventory(null); this.renderer.canvas.requestPointerLock(); return }
      document.exitPointerLock()
      this.hud.showInventory(this.inventory)
      return
    }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5)) - 1
      if (n >= 0 && n < 9) this.selectSlot(n)
    }
    if (e.code === 'KeyQ' && locked) {
      this.conn.send('block_dig', { status: e.ctrlKey ? 3 : 4, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
    }
    if (e.code === 'KeyF' && locked) this.conn.send('block_dig', { status: 6, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
    if (e.code === 'Space' && !e.repeat) {
      const now = performance.now()
      if (now - this.lastSpace < 300 && this.player.canFly && !this.player.spectator) this.player.flying = !this.player.flying
      this.lastSpace = now
    }
    this.keys.add(e.code)
  }
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Tab') this.hud.showTab(false)
    this.keys.delete(e.code)
  }
  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.renderer.canvas) return
    const s = this.opts.sensitivity * 0.15
    this.player.yaw += e.movementX * s
    this.player.pitch = Math.max(-90, Math.min(90, this.player.pitch + e.movementY * s))
  }
  private onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.renderer.canvas) {
      if (e.target === this.renderer.canvas && !this.hud.anyScreenOpen()) this.renderer.canvas.requestPointerLock()
      return
    }
    if (e.button === 0) { this.mouse.left = true; this.attackOrDig(true) }
    if (e.button === 2) { this.mouse.right = true; this.useOrPlace() ; this.placeCooldown = 4 }
    if (e.button === 1) this.pickBlock()
  }
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) { this.mouse.left = false; this.cancelDig() }
    if (e.button === 2) this.mouse.right = false
  }
  private onWheel = (e: WheelEvent) => {
    if (document.pointerLockElement !== this.renderer.canvas) return
    this.selectSlot((this.selected + (e.deltaY > 0 ? 1 : 8)) % 9)
  }
  private onBlur = () => { this.keys.clear(); this.mouse.left = this.mouse.right = false }
  private onLockChange = () => {
    if (document.pointerLockElement !== this.renderer.canvas && !this.hud.anyScreenOpen() && !this.closed) this.hud.showPause(true)
  }

  private bindInput() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('wheel', this.onWheel, { passive: true })
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('pointerlockchange', this.onLockChange)
    this.renderer.canvas.addEventListener('contextmenu', e => e.preventDefault())
  }

  private unbindInput() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }

  private selectSlot(n: number) {
    if (n === this.selected) return
    this.selected = n
    this.conn.send('held_item_slot', { slotId: n })
    this.refreshHotbar()
  }

  private closeContainer() {
    if (this.container) this.conn.send('close_window', { windowId: this.container.id })
    this.container = null
    this.hud.showContainer(null, [])
    this.renderer.canvas.requestPointerLock()
  }

  private input(): Input {
    const k = this.keys
    return {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      strafe: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      jump: k.has('Space'),
      sneak: k.has('ShiftLeft') || k.has('ShiftRight'),
      sprint: k.has('ControlLeft') || k.has('ControlRight')
    }
  }

  // ------------------------------------------------------------------ interaction

  private reach() {
    return this.gamemode === 1 ? 5 : 4.5
  }

  private lookDir(): [number, number, number] {
    const y = (this.player.yaw * Math.PI) / 180, p = (this.player.pitch * Math.PI) / 180
    return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]
  }

  private raycastBlock(): { x: number; y: number; z: number; face: number; hit: number[]; dist: number } | null {
    const pl = this.player
    const ox = pl.x, oy = pl.y + pl.eyeHeight, oz = pl.z
    const [dx, dy, dz] = this.lookDir()
    const max = this.reach()
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz)
    const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz)
    const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz)
    let tx = (sx > 0 ? x + 1 - ox : ox - x) * tdx, ty = (sy > 0 ? y + 1 - oy : oy - y) * tdy, tz = (sz > 0 ? z + 1 - oz : oz - z) * tdz
    for (let i = 0; i < 64; i++) {
      const s = this.world.getState(x, y, z)
      if (s && !this.assets.baked[s]?.invisible && this.data.blocks.name(s) !== 'water' && this.data.blocks.name(s) !== 'lava') {
        let boxes = this.data.blocks.collision(s)
        if (!boxes.length) boxes = [[0, 0, 0, 1, 1, 1]]
        let best: number | null = null
        for (const b of boxes) {
          const t = rayBox(ox, oy, oz, dx, dy, dz, x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5])
          if (t !== null && (best === null || t < best)) best = t
        }
        if (best !== null && best <= max) {
          const hx = ox + dx * best, hy = oy + dy * best, hz = oz + dz * best
          const face = hitFace(hx - x, hy - y, hz - z, boxes)
          return { x, y, z, face, hit: [hx - x, hy - y, hz - z], dist: best }
        }
      }
      const tmin = Math.min(tx, ty, tz)
      if (tmin > max) break
      if (tx === tmin) { x += sx; tx += tdx } else if (ty === tmin) { y += sy; ty += tdy } else { z += sz; tz += tdz }
    }
    return null
  }

  private raycastEntity(blockDist: number) {
    const pl = this.player
    const [dx, dy, dz] = this.lookDir()
    return this.entities.raycast(pl.x, pl.y + pl.eyeHeight, pl.z, dx, dy, dz, Math.min(blockDist, this.gamemode === 1 ? 5 : 3), this.entityId)
  }

  private attackOrDig(click: boolean) {
    if (this.dead || this.gamemode === 3) return
    const b = this.raycastBlock()
    const ent = this.raycastEntity(b ? b.dist : 99)
    if (ent && click) {
      this.conn.send('attack', { entityId: ent.e.id })
      this.conn.send('arm_animation', { hand: 'main_hand' })
      return
    }
    if (!b) { if (click) this.conn.send('arm_animation', { hand: 'main_hand' }); return }
    if (this.gamemode === 2) return
    if (this.gamemode === 1) {
      if (!click && this.attackCooldown > 0) return
      this.attackCooldown = 5
      this.conn.send('block_dig', { status: 0, location: { x: b.x, y: b.y, z: b.z }, face: b.face, sequence: this.sequence++ })
      this.conn.send('arm_animation', { hand: 'main_hand' })
      this.world.setState(b.x, b.y, b.z, 0)
      return
    }
    if (this.dig && this.dig.x === b.x && this.dig.y === b.y && this.dig.z === b.z) return
    this.cancelDig()
    const needed = this.digTicks(this.world.getState(b.x, b.y, b.z))
    if (needed < 0) return
    this.conn.send('block_dig', { status: 0, location: { x: b.x, y: b.y, z: b.z }, face: b.face, sequence: this.sequence++ })
    this.dig = { x: b.x, y: b.y, z: b.z, face: b.face, ticks: 0, needed }
    if (needed === 0) this.finishDig()
  }

  private digTicks(state: number): number {
    const def = this.data.blocks.block(state)
    if (def.hardness < 0) return -1
    if (def.hardness === 0) return 0
    const held = this.inventory[36 + this.selected]?.name ?? ''
    const toolType = (held.match(/_(pickaxe|axe|shovel|hoe|sword)$/) || [])[1]
    const tier = (held.match(/^(wooden|stone|copper|iron|diamond|netherite|golden)_/) || [])[1]
    const right = toolType && def.material.includes(toolType)
    let speed = right ? TOOL_TIER[tier ?? ''] ?? 1 : 1
    if (held === 'shears' && /leaves|wool|cobweb/.test(def.name)) speed = def.name === 'cobweb' ? 15 : 2
    const canHarvest = !def.needsTool || right
    let damage = speed / def.hardness / (canHarvest ? 30 : 100)
    if (this.player.inWater) damage /= 5
    if (!this.player.onGround && !this.player.flying) damage /= 5
    if (damage >= 1) return 0
    return Math.ceil(1 / damage) + 1
  }

  private finishDig() {
    const d = this.dig
    if (!d) return
    this.conn.send('block_dig', { status: 2, location: { x: d.x, y: d.y, z: d.z }, face: d.face, sequence: this.sequence++ })
    this.conn.send('arm_animation', { hand: 'main_hand' })
    this.world.setState(d.x, d.y, d.z, 0)
    this.dig = null
    this.hud.digProgress(0)
  }

  private cancelDig() {
    const d = this.dig
    if (!d) return
    this.conn.send('block_dig', { status: 1, location: { x: d.x, y: d.y, z: d.z }, face: d.face, sequence: this.sequence++ })
    this.dig = null
    this.hud.digProgress(0)
  }

  private useOrPlace() {
    if (this.dead) return
    const b = this.raycastBlock()
    const ent = this.raycastEntity(b ? b.dist : 99)
    if (ent) {
      this.conn.send('use_entity', { target: ent.e.id, hand: 'main_hand', location: { x: 0, y: 0, z: 0 }, sneaking: this.player.sneaking })
      this.conn.send('arm_animation', { hand: 'main_hand' })
      return
    }
    if (b && this.gamemode !== 3) {
      this.conn.send('block_place', {
        hand: 'main_hand', location: { x: b.x, y: b.y, z: b.z }, direction: b.face,
        cursorX: clamp01(b.hit[0]), cursorY: clamp01(b.hit[1]), cursorZ: clamp01(b.hit[2]),
        insideBlock: false, worldBorderHit: false, sequence: this.sequence++
      })
      this.conn.send('arm_animation', { hand: 'main_hand' })
      return
    }
    this.conn.send('use_item', { hand: 'main_hand', sequence: this.sequence++, rotation: { x: this.player.yaw, y: this.player.pitch } })
  }

  private pickBlock() {
    const b = this.raycastBlock()
    if (b) this.conn.send('pick_item_from_block', { position: { x: b.x, y: b.y, z: b.z }, includeData: false })
  }

  // ------------------------------------------------------------------ loop

  private tick() {
    if (!this.loaded || this.dead) return
    const pl = this.player
    const inp = this.hud.typing || this.hud.anyScreenOpen() ? { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false } : this.input()
    const cx = Math.floor(pl.x) >> 4, cz = Math.floor(pl.z) >> 4
    if (this.world.column(cx, cz)) pl.tick(this.world, inp)

    // inputs (1.21.2+: sneaking comes from player_input)
    const flags = { forward: inp.forward > 0, backward: inp.forward < 0, left: inp.strafe < 0, right: inp.strafe > 0, jump: inp.jump, shift: inp.sneak, sprint: inp.sprint }
    const ks = JSON.stringify(flags)
    if (ks !== this.lastInputs) { this.conn.send('player_input', { inputs: flags }); this.lastInputs = ks }
    if (pl.sprinting !== this.lastSprint) {
      this.conn.send('entity_action', { entityId: this.entityId, actionId: pl.sprinting ? 'start_sprinting' : 'stop_sprinting', jumpBoost: 0 })
      this.lastSprint = pl.sprinting
    }
    if (pl.flying !== this.lastFlying && pl.canFly) {
      this.conn.send('abilities', { flags: pl.flying ? 0x02 : 0 })
      this.lastFlying = pl.flying
    }

    const L = this.lastSent
    const moved = (pl.x - L.x) ** 2 + (pl.y - L.y) ** 2 + (pl.z - L.z) ** 2 > 4e-8 || L.ticks >= 20
    const rotated = pl.yaw !== L.yaw || pl.pitch !== L.pitch
    const f = { onGround: pl.onGround, hasHorizontalCollision: pl.horizontalCollision }
    if (moved && rotated) this.conn.send('position_look', { x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, flags: f })
    else if (moved) this.conn.send('position', { x: pl.x, y: pl.y, z: pl.z, flags: f })
    else if (rotated) this.conn.send('look', { yaw: pl.yaw, pitch: pl.pitch, flags: f })
    else if (pl.onGround !== L.ground) this.conn.send('flying', { flags: f })
    if (moved) { L.x = pl.x; L.y = pl.y; L.z = pl.z; L.ticks = 0 } else L.ticks++
    if (rotated) { L.yaw = pl.yaw; L.pitch = pl.pitch }
    L.ground = pl.onGround

    // held mouse buttons
    if (this.placeCooldown > 0) this.placeCooldown--
    if (this.attackCooldown > 0) this.attackCooldown--
    if (this.mouse.right && this.placeCooldown === 0) { this.useOrPlace(); this.placeCooldown = 4 }
    if (this.mouse.left) {
      if (this.gamemode === 1) this.attackOrDig(false)
      else {
        const b = this.raycastBlock()
        if (!b || !this.dig || b.x !== this.dig.x || b.y !== this.dig.y || b.z !== this.dig.z) { this.cancelDig(); if (b) this.attackOrDig(false) }
        else {
          this.dig.ticks++
          this.hud.digProgress(this.dig.ticks / this.dig.needed)
          if (this.dig.ticks % 4 === 0) this.conn.send('arm_animation', { hand: 'main_hand' })
          if (this.dig.ticks >= this.dig.needed) this.finishDig()
        }
      }
    }
    this.conn.send('tick_end', {})
  }

  private loop = () => {
    if (this.closed) return
    const now = performance.now()
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.accumulator += dt
    while (this.accumulator >= 0.05) {
      this.accumulator -= 0.05
      this.tick()
    }
    const pl = this.player
    const cam = this.renderer.camera
    // interpolate the eye a little for smoothness between 20 Hz ticks
    const a = this.accumulator / 0.05
    cam.position.set(pl.x + pl.vx * a, pl.y + pl.eyeHeight + (this.player.onGround ? 0 : pl.vy * a), pl.z + pl.vz * a)
    cam.rotation.set(-(pl.pitch * Math.PI) / 180, Math.PI - (pl.yaw * Math.PI) / 180, 0)
    this.renderer.setTime(this.dayTime, this.dimension)
    this.renderer.updateMeshes(this.loaded ? 6 : 14)
    this.entities.update(dt)
    // outline
    const t = this.loaded ? this.raycastBlock() : null
    const o = this.renderer.outline
    if (t) {
      const boxes = this.data.blocks.collision(this.world.getState(t.x, t.y, t.z))
      const b = boxes.length === 1 ? boxes[0] : [0, 0, 0, 1, 1, 1]
      o.visible = true
      o.position.set(t.x + (b[0] + b[3]) / 2, t.y + (b[1] + b[4]) / 2, t.z + (b[2] + b[5]) / 2)
      o.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2])
    } else o.visible = false
    this.target = t
    this.renderer.render()
    this.frames++
    if (now - this.fpsAt > 1000) { this.fps = this.frames; this.frames = 0; this.fpsAt = now }
    if (this.hud.debugOn) this.hud.setDebug(this.debugLines())
    this.raf = requestAnimationFrame(this.loop)
  }

  private debugLines(): string[] {
    const p = this.player
    const t = this.target
    const ts = t ? this.world.getState(t.x, t.y, t.z) : 0
    return [
      `Beacon · ${this.data.info.version} (protocol ${this.data.info.protocol}) · ${this.fps} fps`,
      `XYZ ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Facing yaw ${p.yaw.toFixed(1)} pitch ${p.pitch.toFixed(1)}`,
      `Chunk ${Math.floor(p.x) >> 4} ${Math.floor(p.z) >> 4} · loaded ${this.world.columns.size} · meshes queued ${this.world.dirty.size}`,
      `${this.dimension} · time ${Math.floor(this.dayTime)} · ${p.onGround ? 'on ground' : 'air'}${p.flying ? ' · flying' : ''}`,
      `Entities ${this.entities.map.size} · players ${this.players.size}`,
      t ? `Looking at ${t.x} ${t.y} ${t.z}: ${this.data.blocks.name(ts)} ${JSON.stringify(this.data.blocks.props(ts))}` : ''
    ]
  }

  end(reason: any, transfer?: { host: string; port: number }) {
    if (this.closed) return
    this.closed = true
    cancelAnimationFrame(this.raf)
    clearInterval(this.tickTimer)
    this.unbindInput()
    this.conn.close()
    document.exitPointerLock()
    this.entities.clear()
    this.onEnd(reason, transfer)
  }

  leave() {
    this.end(null)
  }
}

function gmNum(g: any): number {
  if (typeof g === 'number') return g
  return { survival: 0, creative: 1, adventure: 2, spectator: 3 }[g as string] ?? 0
}

function normUuid(u: any): string {
  return String(u).replace(/-/g, '').toLowerCase()
}

function toNum(v: any): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v[0] * 4294967296 + (v[1] >>> 0)
  return Number(v?.valueOf?.() ?? 0)
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function hitFace(hx: number, hy: number, hz: number, boxes: number[][]): number {
  // which face of the hit box is closest to the hit point
  let best = 1, bestD = Infinity
  for (const b of boxes) {
    const cand: [number, number][] = [[Math.abs(hy - b[1]), 0], [Math.abs(hy - b[4]), 1], [Math.abs(hz - b[2]), 2], [Math.abs(hz - b[5]), 3], [Math.abs(hx - b[0]), 4], [Math.abs(hx - b[3]), 5]]
    for (const [d, f] of cand) if (d < bestD) { bestD = d; best = f }
  }
  return best
}

export { DIR_VEC }
