// Turns minecraft-data JSON (data-src/<version>) into the compact files the client loads
// from public/data/<version>/. Run with: node scripts/build-data.mjs
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const src = path.join(root, 'data-src')
const out = path.join(root, 'public', 'data')
const versions = fs.readdirSync(src).filter(v => fs.existsSync(path.join(src, v, 'protocol.json'))).sort()
const read = (v, f) => JSON.parse(fs.readFileSync(path.join(src, v, f), 'utf8'))
const write = (rel, obj) => {
  const p = path.join(out, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj))
  return fs.statSync(p).size
}

const index = []
for (const v of versions) {
  const ver = read(v, 'version.json')
  const blocks = read(v, 'blocks.json')
  const shapes = read(v, 'blockCollisionShapes.json')
  const entities = read(v, 'entities.json')
  const items = read(v, 'items.json')

  const compactBlocks = blocks
    .sort((a, b) => a.minStateId - b.minStateId)
    .map(b => {
      const props = (b.states || []).map(s => [s.name, s.type === 'bool' ? ['true', 'false'] : s.values ?? Array.from({ length: s.num_values }, (_, i) => String(i))])
      let shape = shapes.blocks[b.name] ?? 0
      if (Array.isArray(shape) && shape.every(x => x === shape[0])) shape = shape[0]
      return {
        n: b.name,
        min: b.minStateId,
        max: b.maxStateId,
        def: b.defaultState,
        p: props,
        tr: b.transparent ? 1 : 0,
        em: b.emitLight || 0,
        fl: b.filterLight || 0,
        h: b.hardness ?? 0,
        m: b.material || 'default',
        rt: b.harvestTools ? 1 : 0,
        s: shape
      }
    })

  let size = 0
  size += write(`${v}/protocol.json`, read(v, 'protocol.json'))
  size += write(`${v}/blocks.json`, { blocks: compactBlocks, shapes: shapes.shapes })
  size += write(`${v}/entities.json`, entities.map(e => ({ id: e.id, n: e.name, w: e.width, h: e.height, t: e.type })))
  size += write(`${v}/items.json`, items.map(i => ({ id: i.id, n: i.name, d: i.displayName })))
  index.push({ version: v, protocol: ver.version })
  console.log(`${v} (protocol ${ver.version}): ${(size / 1024).toFixed(0)} KB`)
}

// One English language file (newest version) for translatable chat messages.
const latest = versions[versions.length - 1]
write('lang.json', read(latest, 'language.json'))
write('versions.json', index)
console.log('versions:', index.map(i => `${i.version}=${i.protocol}`).join(', '))
