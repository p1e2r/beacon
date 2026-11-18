import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { Codec } from '../src/net/codec'
import { offlineUuid } from '../src/net/md5'

for (const v of ['26.1', '26.2', '26.3']) {
  test(`codec ${v}: encodes client packets and decodes server packets`, () => {
    const protocol = JSON.parse(fs.readFileSync(new URL(`../public/data/${v}/protocol.json`, import.meta.url), 'utf8'))
    const c = new Codec(protocol)
    const hs = c.encode('handshaking', 'set_protocol', { protocolVersion: 776, serverHost: 'a', serverPort: 25565, nextState: 2 })
    assert.deepStrictEqual(Array.from(hs), [0, 0x88, 0x06, 1, 97, 0x63, 0xdd, 2])
    c.encode('login', 'login_start', { username: 'Steve', playerUUID: offlineUuid('Steve') })
    c.encode('configuration', 'settings', { locale: 'en_us', viewDistance: 8, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true, particleStatus: 'all' })
    c.encode('configuration', 'select_known_packs', { packs: [] })
    c.encode('play', 'position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } })
    c.encode('play', 'chat_message', { message: 'hi', timestamp: BigInt(Date.now()), salt: 0n, signature: undefined, offset: 0, acknowledged: Buffer.alloc(3), checksum: 0 })
    c.encode('play', 'chat_command', { command: 'login pass' })
    c.encode('play', 'block_dig', { status: 0, location: { x: 1, y: 64, z: -3 }, face: 1, sequence: 1 })
    c.encode('play', 'block_place', { hand: 'main_hand', location: { x: 1, y: 64, z: -3 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: 2 })
    c.encode('play', 'player_input', { inputs: { forward: true } })
    c.encode('play', 'chunk_batch_received', { chunksPerTick: 9 })
    c.encode('play', 'tick_end', {})
    c.encode('play', 'player_loaded', {})
    // a server packet: block_change encoded by hand: id, position(long), varint state
    const names = c.names('play', 'toClient')
    const id = Number(Object.entries(names).find(([, n]) => n === 'block_change')![0])
    const pos = (BigInt(5) << 38n) | (BigInt(-2 & 0x3ffffff) << 12n) | BigInt(70)
    const b = Buffer.alloc(8); b.writeBigUInt64BE(pos)
    const pkt = new Uint8Array([id, ...b, 0x81, 0x01])
    const p = c.decode('play', pkt)
    assert.strictEqual(p.name, 'block_change')
    assert.deepStrictEqual({ ...p.params.location }, { x: 5, z: -2, y: 70 })
    assert.strictEqual(p.params.type, 129)
  })
}

test('offline uuid matches the Java server', () => {
  // UUID.nameUUIDFromBytes("OfflinePlayer:Notch")
  assert.strictEqual(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f')
})
