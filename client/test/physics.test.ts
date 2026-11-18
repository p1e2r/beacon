import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { BlockRegistry } from '../src/world/blocks'
import { World } from '../src/world/world'
import { Column } from '../src/world/chunk'
import { Player } from '../src/game/player'

function flatWorld() {
  const reg = new BlockRegistry(JSON.parse(fs.readFileSync(new URL('../public/data/26.1/blocks.json', import.meta.url), 'utf8')))
  const w = new World(reg)
  const stone = reg.stateFor('stone')
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) {
    const col = new Column(cx, cz, 24)
    w.columns.set(`${cx},${cz}`, col)
  }
  for (let x = -32; x < 32; x++) for (let z = -32; z < 32; z++) w.setState(x, 63, z, stone)
  return { w, reg, stone }
}
const idle = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false }

test('walks forward on flat ground at vanilla speed', () => {
  const { w } = flatWorld()
  const p = new Player(); p.x = 0.5; p.y = 64; p.z = 0.5
  for (let i = 0; i < 5; i++) p.tick(w, idle)
  assert.ok(p.onGround, 'lands on ground')
  for (let i = 0; i < 20; i++) p.tick(w, { ...idle, forward: 1 })
  const d = p.z - 0.5
  assert.ok(d > 3.5 && d < 5, `moved ${d} blocks in 1s (vanilla walk ≈ 4.3)`)
  assert.ok(Math.abs(p.y - 64) < 1e-6)
})

test('steps up a one-slab-high ledge but not a full block', () => {
  const { w, reg } = flatWorld()
  const slab = reg.stateFor('stone_slab', { type: 'bottom' })
  for (let x = -5; x < 5; x++) for (let z = 3; z < 8; z++) w.setState(x, 64, z, slab)
  const p = new Player(); p.x = 0.5; p.y = 64; p.z = 0.5
  for (let i = 0; i < 3; i++) p.tick(w, idle)
  for (let i = 0; i < 30; i++) p.tick(w, { ...idle, forward: 1 })
  assert.ok(p.z > 4 && p.z < 8, `walked onto the slabs (z=${p.z})`)
  assert.ok(Math.abs(p.y - 64.5) < 1e-6, `stands on slab (y=${p.y})`)
  const stone = reg.stateFor('stone')
  for (let x = -5; x < 5; x++) { w.setState(x, 65, 8, stone); w.setState(x, 64, 8, stone) }
  for (let i = 0; i < 40; i++) p.tick(w, { ...idle, forward: 1 })
  assert.ok(p.z < 7.71 && p.z > 7.6, `blocked by full block (z=${p.z})`)
})

test('jumps onto a block', () => {
  const { w, reg } = flatWorld()
  const stone = reg.stateFor('stone')
  for (let x = -5; x < 5; x++) w.setState(x, 64, 2, stone)
  const p = new Player(); p.x = 0.5; p.y = 64; p.z = 0.5
  for (let i = 0; i < 3; i++) p.tick(w, idle)
  for (let i = 0; i < 25; i++) p.tick(w, { ...idle, forward: 1, jump: true })
  assert.ok(p.y >= 65 && p.z > 2, `on top (y=${p.y}, z=${p.z})`)
})
