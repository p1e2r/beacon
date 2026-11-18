// Test fixture: a tiny offline-mode 26.1 server (node-minecraft-protocol) with a small world.
import mc from 'minecraft-protocol'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const Vec3 = require('vec3')
const mcData = require('minecraft-data')('26.1')

const port = Number(process.env.PORT || 25599)
const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port, version: '26.1', motd: '§bBeacon §ftest server', maxPlayers: 10 })
const B = n => registry.blocksByName[n].defaultState
const st = (n, props) => {
  const b = registry.blocksByName[n]
  let id = b.minStateId
  // use prismarine-block to compute state from props
  const Block = require('prismarine-block')(registry)
  const blk = Block.fromProperties(n, props, 0)
  return blk.stateId ?? id
}

function makeChunk(cx, cz) {
  const c = new Chunk({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const wx = cx * 16 + x, wz = cz * 16 + z
    c.setBlockStateId(new Vec3(x, -64, z), B('bedrock'))
    for (let y = -63; y < 60; y++) c.setBlockStateId(new Vec3(x, y, z), B('stone'))
    for (let y = 60; y < 63; y++) c.setBlockStateId(new Vec3(x, y, z), B('dirt'))
    const h = 63 + (Math.sin(wx / 7) + Math.cos(wz / 9) > 1.2 ? 1 : 0)
    for (let y = 63; y < h; y++) c.setBlockStateId(new Vec3(x, y, z), B('dirt'))
    c.setBlockStateId(new Vec3(x, h, z), B('grass_block'))
    if ((wx * 7 + wz * 13) % 11 === 0) c.setBlockStateId(new Vec3(x, h + 1, z), B('short_grass'))
    if ((wx * 5 + wz * 3) % 37 === 0) c.setBlockStateId(new Vec3(x, h + 1, z), B('poppy'))
    // pool
    if (wx >= 4 && wx <= 8 && wz >= -8 && wz <= -4) { c.setBlockStateId(new Vec3(x, 63, z), B('water')); c.setBlockStateId(new Vec3(x, 62, z), B('sand')) }
  }
  // a little hut at 0..5, 0..5
  if (cx === 0 && cz === 0) {
    for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) for (let y = 64; y <= 67; y++) {
      const wall = x === 0 || x === 5 || z === 0 || z === 5
      if (y === 67) c.setBlockStateId(new Vec3(x, y, z), B('oak_planks'))
      else if (wall) c.setBlockStateId(new Vec3(x, y, z), (y === 65 && (x === 2 || z === 2)) ? B('glass') : (x === 0 || x === 5) && (z === 0 || z === 5) ? st('oak_log', { axis: 'y' }) : B('cobblestone'))
    }
    c.setBlockStateId(new Vec3(2, 64, 0), B('air')); c.setBlockStateId(new Vec3(2, 65, 0), B('air'))
    c.setBlockStateId(new Vec3(3, 64, 3), B('crafting_table'))
    c.setBlockStateId(new Vec3(1, 64, 4), st('oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false }))
    c.setBlockStateId(new Vec3(4, 64, 1), st('torch', {}))
    for (let i = 0; i < 6; i++) c.setBlockStateId(new Vec3(8, 64 + i, 8), st('oak_log', { axis: 'y' }))
    for (let x = 6; x <= 10; x++) for (let z = 6; z <= 10; z++) for (let y = 68; y <= 70; y++) if (!(x === 8 && z === 8 && y < 70)) c.setBlockStateId(new Vec3(x, y, z), B('oak_leaves'))
  }
  return c
}

const SECTIONS = 24
const fullSky = Array.from({ length: SECTIONS + 2 }, () => Array.from({ length: 2048 }, () => 0xff))
const allBits = [0, (1 << (SECTIONS + 2)) - 1]

server.on('playerJoin', client => {
  console.log('[fixture] join', client.username, client.uuid)
  const log = (n) => client.on(n, p => console.log('[fixture] <-', n, JSON.stringify(p, (k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 200)))
  ;['chat_command', 'chat_message', 'block_dig', 'block_place', 'player_loaded', 'teleport_confirm', 'chunk_batch_received', 'held_item_slot', 'settings', 'player_input'].forEach(log)
  let moves = 0
  client.on('position', p => { if (moves++ % 40 === 0) console.log('[fixture] <- position', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(p.flags)) })
  client.on('position_look', p => { if (moves++ % 40 === 0) console.log('[fixture] <- position_look', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(p.flags)) })
  client.write('login', { ...mcData.loginPacket, entityId: client.id, worldState: { ...mcData.loginPacket.worldState, gamemode: 'creative', isFlat: true }, viewDistance: 4 })
  client.write('chunk_batch_start', {})
  let n = 0
  for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) {
    const c = makeChunk(cx, cz)
    client.write('map_chunk', {
      x: cx, z: cz, heightmaps: [], chunkData: c.dump(), blockEntities: [],
      skyLightMask: [allBits], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [allBits],
      skyLight: fullSky, blockLight: []
    })
    n++
  }
  client.write('chunk_batch_finished', { batchSize: n })
  client.write('game_state_change', { reason: 'level_chunks_load_start', gameMode: 0 })
  client.write('abilities', { flags: 0x04 | 0x08 | 0x01, flyingSpeed: 0.05, walkingSpeed: 0.1 })
  client.write('position', { teleportId: 1, x: 2.5, y: 64, z: -3.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 10, flags: {} })
  client.write('system_chat', { content: { type: 'compound', value: { text: { type: 'string', value: 'Welcome to the ' }, extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'Beacon' }, color: { type: 'string', value: 'aqua' } }, { text: { type: 'string', value: ' test server!' } }] } } } }, isActionBar: false })
  // a zombie and another player-ish entity
  const zombie = mcData.entitiesByName.zombie.id
  client.write('spawn_entity', { entityId: 1000, objectUUID: '00000000-0000-0000-0000-000000000001', type: zombie, x: 6.5, y: 64, z: -1.5, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 64, headPitch: 0, objectData: 0 })
  client.on('chat_command', p => client.write('system_chat', { content: { type: 'string', value: `§aYou ran /${p.command}` }, isActionBar: false }))
  client.on('chat_message', p => client.write('system_chat', { content: { type: 'string', value: `<${client.username}> ${p.message}` }, isActionBar: false }))
  client.on('block_dig', p => {
    if (p.status === 0) client.write('block_change', { location: p.location, type: 0 })
    client.write('acknowledge_player_digging', { sequenceId: p.sequence })
  })
  client.on('block_place', p => {
    const d = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][p.direction]
    client.write('block_change', { location: { x: p.location.x + d[0], y: p.location.y + d[1], z: p.location.z + d[2] }, type: B('glowstone') })
  })
  const ka = setInterval(() => client.write('keep_alive', { keepAliveId: BigInt(Date.now()) }), 5000)
  client.on('end', () => { clearInterval(ka); console.log('[fixture] left') })
})
server.on('listening', () => console.log('[fixture] listening on', port))
server.on('error', e => console.log('[fixture] error', e))
