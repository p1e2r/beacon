// Local player movement, close to vanilla's numbers so servers don't rubber-band us.
import { World } from '../world/world'

export interface Input {
  forward: number // -1..1
  strafe: number // -1..1 (right positive)
  jump: boolean
  sneak: boolean
  sprint: boolean
}

type AABB = [number, number, number, number, number, number]

const CLIMBABLE = /ladder|vine|scaffolding|twisting_vines|weeping_vines|cave_vines/

export class Player {
  x = 0; y = 0; z = 0
  vx = 0; vy = 0; vz = 0
  yaw = 0 // degrees, Minecraft convention (0 = +z / south)
  pitch = 0
  onGround = false
  horizontalCollision = false
  flying = false
  canFly = false
  flySpeed = 0.05
  walkSpeed = 0.1
  sneaking = false
  sprinting = false
  inWater = false
  inLava = false
  width = 0.6
  height = 1.8
  spectator = false

  get eyeHeight() {
    return this.sneaking && !this.flying ? 1.27 : 1.62
  }

  private boxes(world: World, bb: AABB): AABB[] {
    const out: AABB[] = []
    const reg = world.reg
    const x0 = Math.floor(bb[0]) - 1, x1 = Math.floor(bb[3]) + 1
    const y0 = Math.floor(bb[1]) - 1, y1 = Math.floor(bb[4]) + 1
    const z0 = Math.floor(bb[2]) - 1, z1 = Math.floor(bb[5]) + 1
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (!world.loaded(x, z)) {
        // unloaded chunks are solid so we don't fall into the void while they arrive
        out.push([x, y0, z, x + 1, y1 + 1, z + 1])
        continue
      }
      for (let y = y0; y <= y1; y++) {
        const s = world.getState(x, y, z)
        if (s === 0) continue
        for (const b of reg.collision(s)) out.push([x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]])
      }
    }
    return out
  }

  bb(): AABB {
    const w = this.width / 2
    return [this.x - w, this.y, this.z - w, this.x + w, this.y + this.height, this.z + w]
  }

  private move(world: World, dx: number, dy: number, dz: number) {
    if (this.spectator) { this.x += dx; this.y += dy; this.z += dz; this.onGround = false; return }
    const ox = dx, oy = dy, oz = dz
    // sneaking at an edge: don't walk off
    if (this.sneaking && this.onGround && !this.flying) {
      const step = 0.05
      const supported = (ax: number, az: number) => {
        const b = this.bb()
        return this.boxes(world, [b[0] + ax, b[1] - 0.6, b[2] + az, b[3] + ax, b[1], b[5] + az])
          .some(c => c[0] < b[3] + ax && c[3] > b[0] + ax && c[2] < b[5] + az && c[5] > b[2] + az && c[4] > b[1] - 0.6 && c[1] < b[1])
      }
      while (dx !== 0 && !supported(dx, 0)) dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step
      while (dz !== 0 && !supported(0, dz)) dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step
      while (dx !== 0 && dz !== 0 && !supported(dx, dz)) {
        dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step
        dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step
      }
    }
    const start = this.bb()
    const reach: AABB = [
      Math.min(start[0], start[0] + dx), Math.min(start[1], start[1] + dy) - 0.6, Math.min(start[2], start[2] + dz),
      Math.max(start[3], start[3] + dx), Math.max(start[4], start[4] + dy) + 0.6, Math.max(start[5], start[5] + dz)
    ]
    const boxes = this.boxes(world, reach)
    const res = sweep(start, boxes, dx, dy, dz)
    let [mx, my, mz] = res
    // step up (0.6 blocks) when walking into a low obstacle
    const blockedH = (mx !== dx || mz !== dz)
    if (blockedH && (this.onGround || (oy < 0 && my !== oy)) && !this.flying) {
      const up = sweep(start, boxes, 0, 0.6, 0)[1]
      const moved = offset(start, 0, up, 0)
      const h = sweep(moved, boxes, dx, 0, dz)
      const moved2 = offset(moved, h[0], 0, h[2])
      const down = sweep(moved2, boxes, 0, -up + Math.min(0, dy), 0)[1]
      if (h[0] * h[0] + h[2] * h[2] > mx * mx + mz * mz + 1e-6) {
        mx = h[0]; mz = h[2]; my = up + down
      }
    }
    this.x += mx; this.y += my; this.z += mz
    this.horizontalCollision = Math.abs(mx - ox) > 1e-5 || Math.abs(mz - oz) > 1e-5
    this.onGround = oy < 0 && Math.abs(my - dy) > 1e-7 && my > dy
    if (Math.abs(my - dy) > 1e-7) this.vy = 0
    if (Math.abs(mx - dx) > 1e-7) this.vx = 0
    if (Math.abs(mz - dz) > 1e-7) this.vz = 0
  }

  private inBlock(world: World, test: (name: string, s: number) => boolean): boolean {
    const b = this.bb()
    for (let x = Math.floor(b[0] + 0.001); x <= Math.floor(b[3] - 0.001); x++)
      for (let y = Math.floor(b[1] + 0.001); y <= Math.floor(b[4] - 0.001); y++)
        for (let z = Math.floor(b[2] + 0.001); z <= Math.floor(b[5] - 0.001); z++) {
          const s = world.getState(x, y, z)
          if (s && test(world.reg.name(s), s)) return true
        }
    return false
  }

  tick(world: World, input: Input) {
    const reg = world.reg
    this.inWater = this.inBlock(world, (n, s) => n === 'water' || n === 'bubble_column' || reg.props(s).waterlogged === 'true' || n === 'kelp' || n === 'kelp_plant' || n === 'seagrass' || n === 'tall_seagrass')
    this.inLava = this.inBlock(world, n => n === 'lava')
    this.sneaking = input.sneak && !this.flying
    const moving = input.forward > 0
    if (input.sprint && moving && !this.sneaking) this.sprinting = true
    if (!moving || this.sneaking || this.horizontalCollision) this.sprinting = false

    let f = input.forward, s = input.strafe
    const len = Math.hypot(f, s)
    if (len > 1) { f /= len; s /= len }
    if (this.sneaking) { f *= 0.3; s *= 0.3 }
    f *= 0.98; s *= 0.98

    if (this.flying) {
      const speed = this.flySpeed * (this.sprinting || input.sprint ? 2 : 1)
      this.accelerate(f, s, speed)
      if (input.jump) this.vy += this.flySpeed * 3
      if (input.sneak) this.vy -= this.flySpeed * 3
      this.move(world, this.vx, this.vy, this.vz)
      this.vx *= 0.91; this.vz *= 0.91; this.vy *= 0.6
      if (this.onGround && !this.spectator) this.flying = false
      return
    }

    if (this.inWater || this.inLava) {
      const speed = 0.02
      this.accelerate(f, s, this.sprinting && this.inWater ? speed * 2 : speed)
      if (input.jump) this.vy += 0.04
      this.move(world, this.vx, this.vy, this.vz)
      const drag = this.inWater ? 0.8 : 0.5
      this.vx *= drag; this.vz *= drag; this.vy *= drag
      this.vy -= this.inWater ? 0.005 : 0.02
      if (this.horizontalCollision && input.jump) this.vy = 0.3
      return
    }

    const climbing = this.inBlock(world, n => CLIMBABLE.test(n))
    const block = this.slipperiness(world)
    const slip = this.onGround ? block * 0.91 : 0.91
    let speed: number
    if (this.onGround) {
      const base = this.walkSpeed * (this.sprinting ? 1.3 : 1)
      speed = base * (0.21600002 / (block * block * block))
    } else speed = this.sprinting ? 0.026 : 0.02
    if (input.jump && this.onGround) {
      this.vy = 0.42
      if (this.sprinting) {
        const r = (this.yaw * Math.PI) / 180
        this.vx -= Math.sin(r) * 0.2
        this.vz += Math.cos(r) * 0.2
      }
    }
    this.accelerate(f, s, speed)
    if (climbing) {
      this.vx = clamp(this.vx, -0.15, 0.15)
      this.vz = clamp(this.vz, -0.15, 0.15)
      this.vy = Math.max(this.vy, input.sneak ? 0 : -0.15)
    }
    this.move(world, this.vx, this.vy, this.vz)
    if (climbing && (this.horizontalCollision || input.jump)) this.vy = 0.2
    this.vy = (this.vy - 0.08) * 0.98
    this.vx *= slip
    this.vz *= slip
  }

  private slipperiness(world: World) {
    const s = world.getState(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z))
    const n = world.reg.name(s)
    if (n === 'ice' || n === 'packed_ice' || n === 'frosted_ice') return 0.98
    if (n === 'blue_ice') return 0.989
    if (n === 'slime_block') return 0.8
    return 0.6
  }

  private accelerate(forward: number, strafe: number, speed: number) {
    const r = (this.yaw * Math.PI) / 180
    const sin = Math.sin(r), cos = Math.cos(r)
    // Minecraft: +strafe is left; our strafe is right-positive
    const st = -strafe
    this.vx += (st * cos - forward * sin) * speed
    this.vz += (forward * cos + st * sin) * speed
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

function offset(b: AABB, x: number, y: number, z: number): AABB {
  return [b[0] + x, b[1] + y, b[2] + z, b[3] + x, b[4] + y, b[5] + z]
}

/** Moves a box through others, Y first then X then Z, like vanilla. */
function sweep(start: AABB, boxes: AABB[], dx: number, dy: number, dz: number): [number, number, number] {
  let b = start
  for (const c of boxes) dy = clipY(c, b, dy)
  b = offset(b, 0, dy, 0)
  for (const c of boxes) dx = clipX(c, b, dx)
  b = offset(b, dx, 0, 0)
  for (const c of boxes) dz = clipZ(c, b, dz)
  return [dx, dy, dz]
}
const EPS = 1e-7
function clipY(c: AABB, b: AABB, d: number) {
  if (c[3] <= b[0] + EPS || c[0] >= b[3] - EPS || c[5] <= b[2] + EPS || c[2] >= b[5] - EPS) return d
  if (d > 0 && c[1] >= b[4] - EPS) d = Math.min(d, c[1] - b[4])
  else if (d < 0 && c[4] <= b[1] + EPS) d = Math.max(d, c[4] - b[1])
  return d
}
function clipX(c: AABB, b: AABB, d: number) {
  if (c[4] <= b[1] + EPS || c[1] >= b[4] - EPS || c[5] <= b[2] + EPS || c[2] >= b[5] - EPS) return d
  if (d > 0 && c[0] >= b[3] - EPS) d = Math.min(d, c[0] - b[3])
  else if (d < 0 && c[3] <= b[0] + EPS) d = Math.max(d, c[3] - b[0])
  return d
}
function clipZ(c: AABB, b: AABB, d: number) {
  if (c[4] <= b[1] + EPS || c[1] >= b[4] - EPS || c[3] <= b[0] + EPS || c[0] >= b[3] - EPS) return d
  if (d > 0 && c[2] >= b[5] - EPS) d = Math.min(d, c[2] - b[5])
  else if (d < 0 && c[5] <= b[2] + EPS) d = Math.max(d, c[5] - b[2])
  return d
}
