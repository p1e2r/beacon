// Other players and mobs as simple coloured boxes with name tags.
import * as THREE from 'three'

export interface EntityType { id: number; n: string; w: number; h: number; t: string }

export interface Entity {
  id: number
  uuid: string
  type: EntityType | null
  x: number; y: number; z: number
  tx: number; ty: number; tz: number
  yaw: number; headYaw: number; pitch: number
  name: string | null
  obj: THREE.Object3D | null
  lastUpdate: number
}

const CAT_COLOR: Record<string, number> = { player: 0x3b82c4, hostile: 0x5a9e3a, passive: 0xd9b38c, animal: 0xd9b38c, water_creature: 0x3f8fbf, ambient: 0x8e7a5e, projectile: 0xdddddd, other: 0xaaaaaa, mob: 0xb08850 }
const SPECIAL: Record<string, number> = {
  zombie: 0x3d8b3d, husk: 0x9c8a5a, drowned: 0x3a8c8c, skeleton: 0xcfcfcf, stray: 0xb5c6c8, creeper: 0x4bb04b, spider: 0x3a302a, cave_spider: 0x1f3c45,
  enderman: 0x161616, cow: 0x4a3524, mooshroom: 0xa41e1e, pig: 0xf0a0a0, sheep: 0xeeeeee, chicken: 0xffffff, wolf: 0xc8c0b8, cat: 0xc89a5a,
  horse: 0x8a5a33, villager: 0x9c6b4b, iron_golem: 0xc9bdb2, slime: 0x6ebe5a, item: 0xffe07a, experience_orb: 0x9cff3c, arrow: 0x9a7a50, boat: 0x9a7a50
}

function nameTag(text: string): THREE.Sprite {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  ctx.font = '28px system-ui, sans-serif'
  const w = Math.ceil(ctx.measureText(text).width) + 16
  c.width = w; c.height = 40
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(0, 0, w, 40)
  ctx.font = '28px system-ui, sans-serif'
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 8, 21)
  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.LinearFilter
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  s.scale.set(w / 80, 0.5, 1)
  s.renderOrder = 10
  return s
}

const geoCache = new Map<string, THREE.BoxGeometry>()
const box = (w: number, h: number, d: number) => {
  const k = `${w},${h},${d}`
  let g = geoCache.get(k)
  if (!g) { g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); geoCache.set(k, g) }
  return g
}

function buildMesh(e: Entity): THREE.Object3D {
  const g = new THREE.Group()
  const t = e.type
  const isPlayer = t?.n === 'player'
  const w = t?.w ?? 0.6, h = t?.h ?? 1.8
  const color = SPECIAL[t?.n ?? ''] ?? CAT_COLOR[t?.t ?? 'other'] ?? 0xaaaaaa
  const mat = new THREE.MeshLambertMaterial({ color })
  if (isPlayer) {
    const legs = new THREE.Mesh(box(0.5, 0.75, 0.25), new THREE.MeshLambertMaterial({ color: 0x2b3a8c }))
    const body = new THREE.Mesh(box(0.5, 0.75, 0.25), new THREE.MeshLambertMaterial({ color: 0x1fa3a3 }))
    body.position.y = 0.75
    const head = new THREE.Mesh(box(0.5, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0xc69478 }))
    head.position.y = 1.5
    head.name = 'head'
    const armL = new THREE.Mesh(box(0.25, 0.75, 0.25), new THREE.MeshLambertMaterial({ color: 0xc69478 }))
    armL.position.set(-0.375, 0.75, 0)
    const armR = armL.clone(); armR.position.x = 0.375
    g.add(legs, body, head, armL, armR)
  } else {
    const m = new THREE.Mesh(box(w, h, w), mat)
    g.add(m)
  }
  if (e.name) {
    const tag = nameTag(e.name)
    tag.position.y = h + 0.35
    g.add(tag)
  }
  return g
}

export class Entities {
  map = new Map<number, Entity>()
  constructor(private group: THREE.Group, public types: EntityType[]) {}

  spawn(id: number, uuid: string, typeId: number, x: number, y: number, z: number, yaw: number, pitch: number, name: string | null) {
    this.remove(id)
    const e: Entity = { id, uuid, type: this.types.find(t => t.id === typeId) ?? null, x, y, z, tx: x, ty: y, tz: z, yaw, headYaw: yaw, pitch, name, obj: null, lastUpdate: performance.now() }
    e.obj = buildMesh(e)
    e.obj.position.set(x, y, z)
    this.group.add(e.obj)
    this.map.set(id, e)
    return e
  }

  remove(id: number) {
    const e = this.map.get(id)
    if (!e) return
    if (e.obj) {
      this.group.remove(e.obj)
      e.obj.traverse(o => {
        if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose() }
        else if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose()
      })
    }
    this.map.delete(id)
  }

  clear() {
    for (const id of [...this.map.keys()]) this.remove(id)
  }

  moveTo(id: number, x: number, y: number, z: number) {
    const e = this.map.get(id)
    if (!e) return
    e.tx = x; e.ty = y; e.tz = z
  }

  moveBy(id: number, dx: number, dy: number, dz: number) {
    const e = this.map.get(id)
    if (!e) return
    e.tx += dx; e.ty += dy; e.tz += dz
  }

  update(dt: number) {
    const a = 1 - Math.pow(0.0001, dt) // smooth towards target
    for (const e of this.map.values()) {
      e.x += (e.tx - e.x) * a
      e.y += (e.ty - e.y) * a
      e.z += (e.tz - e.z) * a
      if (!e.obj) continue
      e.obj.position.set(e.x, e.y, e.z)
      e.obj.rotation.y = -(e.yaw * Math.PI) / 180 + Math.PI
      const head = e.obj.getObjectByName('head')
      if (head) head.rotation.set(-(e.pitch * Math.PI) / 180, -((e.headYaw - e.yaw) * Math.PI) / 180, 0)
    }
  }

  /** Ray vs entity boxes. Returns the nearest entity hit within maxDist. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, selfId: number): { e: Entity; dist: number } | null {
    let best: { e: Entity; dist: number } | null = null
    for (const e of this.map.values()) {
      if (e.id === selfId) continue
      const w = (e.type?.w ?? 0.6) / 2 + 0.05, h = (e.type?.h ?? 1.8) + 0.05
      const t = rayBox(ox, oy, oz, dx, dy, dz, e.x - w, e.y, e.z - w, e.x + w, e.y + h, e.z + w)
      if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { e, dist: t }
    }
    return best
  }
}

export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number | null {
  let tmin = 0, tmax = Infinity
  const o = [ox, oy, oz], d = [dx, dy, dz], a = [x0, y0, z0], b = [x1, y1, z1]
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < a[i] || o[i] > b[i]) return null; continue }
    let t1 = (a[i] - o[i]) / d[i], t2 = (b[i] - o[i]) / d[i]
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  return tmin
}
