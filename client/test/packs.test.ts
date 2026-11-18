import test from 'node:test'
import assert from 'node:assert'
import { zipSync, strToU8 } from 'fflate'
import { Pack } from '../src/render/assets'

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

test('packs stack like Minecraft: higher layers replace lower ones', () => {
  const jar = Pack.read(zip({
    'assets/minecraft/textures/block/stone.png': 'vanilla-stone',
    'assets/minecraft/textures/block/dirt.png': 'vanilla-dirt',
    'assets/minecraft/blockstates/stone.json': '{"variants":{"":{"model":"block/stone"}}}',
    'data/minecraft/whatever.json': 'ignored'
  }))
  const pack = Pack.read(zip({ 'assets/minecraft/textures/block/stone.png': 'pack-stone' }))
  const p = Pack.stack([{ name: '26.2.jar', files: jar }, { name: 'MyPack.zip', files: pack }])
  const txt = (k: string) => new TextDecoder().decode(p.files[k])
  assert.strictEqual(txt('assets/minecraft/textures/block/stone.png'), 'pack-stone')
  assert.strictEqual(txt('assets/minecraft/textures/block/dirt.png'), 'vanilla-dirt')
  assert.ok(!('data/minecraft/whatever.json' in p.files))
  assert.strictEqual(p.name, 'MyPack.zip + 26.2.jar')
  assert.ok(p.complete)
})

test('texture-only pack without the jar is flagged incomplete', () => {
  const p = Pack.stack([{ name: 'MyPack.zip', files: Pack.read(zip({ 'assets/minecraft/textures/block/stone.png': 'x' })) }])
  assert.strictEqual(p.complete, false)
})

test('a zip without Minecraft assets is rejected', () => {
  assert.throws(() => Pack.read(zip({ 'readme.txt': 'hi' })), /no Minecraft textures/)
})
