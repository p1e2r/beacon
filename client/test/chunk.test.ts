import test from 'node:test'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { parseColumn } from '../src/world/chunk'
import { BlockRegistry } from '../src/world/blocks'
const require = createRequire(import.meta.url)

test('26.1 chunk section format round-trips with prismarine-chunk', () => {
  const registry = require('prismarine-registry')('26.1')
  const Chunk = require('prismarine-chunk')(registry)
  const c = new Chunk({ minY: -64, worldHeight: 384 })
  const stone = registry.blocksByName.stone.defaultState
  const water = registry.blocksByName.water.defaultState
  const stairs = registry.blocksByName.oak_stairs.minStateId + 7
  const Vec3 = require('vec3')
  const pts: [number, number, number, number][] = []
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y < -60; y++) { c.setBlockStateId(new Vec3(x, y, z), stone); pts.push([x, y, z, stone]) }
  c.setBlockStateId(new Vec3(3, 70, 4), water); pts.push([3, 70, 4, water])
  c.setBlockStateId(new Vec3(15, 319, 15), stairs); pts.push([15, 319, 15, stairs])
  // many distinct states in one section -> direct (global) palette
  let s = 1
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) { const id = (s++ * 37) % 20000 + 1; c.setBlockStateId(new Vec3(x, 100, z), id); pts.push([x, 100, z, id]) }
  const buf: Buffer = c.dump()
  const data = JSON.parse(fs.readFileSync(new URL('../public/data/26.1/blocks.json', import.meta.url), 'utf8'))
  const reg = new BlockRegistry(data)
  const biomeBits = Math.ceil(Math.log2(Object.keys(registry.biomes).length))
  const col = parseColumn(0, 0, new Uint8Array(buf), 24, reg.globalBits, biomeBits, s => reg.isAir(s))
  for (const [x, y, z, id] of pts) {
    const sec = col.sections[(y + 64) >> 4]
    assert.ok(sec, `section for y=${y}`)
    assert.strictEqual(sec![(((y + 64) & 15) << 8) | (z << 4) | x], id, `block at ${x},${y},${z}`)
  }
  assert.strictEqual(col.sections[5], null)
  assert.strictEqual(reg.name(stairs), 'oak_stairs')
  assert.deepStrictEqual(reg.props(registry.blocksByName.oak_stairs.defaultState), { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' })
  assert.strictEqual(reg.stateFor('oak_stairs', {}), registry.blocksByName.oak_stairs.defaultState)
})
