import './style.css'
import { Buffer } from 'buffer'
;(globalThis as any).Buffer ??= Buffer
import { Transport, ProxyError } from './net/transport'
import { pingServer } from './net/connection'
import * as versions from './net/versions'
import { World } from './world/world'
import { Renderer } from './render/renderer'
import { BlockAssets, Pack } from './render/assets'
import { Session } from './game/session'
import { Hud } from './ui/hud'
import { setLanguage, toDom, toPlain } from './game/text'
import * as store from './ui/store'

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T
const canvas = $<HTMLCanvasElement>('#game')
const hud = new Hud($('#hud'))
let settings = store.loadSettings()
let servers = store.loadServers()
let pack: Pack | null = null
let renderer: Renderer | null = null
let session: Session | null = null
const assetCache = new Map<string, BlockAssets>()

// ----------------------------------------------------------------- invite links
// https://proxy/#proxy=https://proxy&key=bk_… fills in the proxy settings once.
;(() => {
  if (!location.hash.includes('key=') && !location.hash.includes('proxy=')) return
  const q = new URLSearchParams(location.hash.slice(1))
  if (q.get('proxy')) settings.proxy = q.get('proxy')!
  if (q.get('key')) settings.key = q.get('key')!
  store.saveSettings(settings)
  history.replaceState(null, '', location.pathname + location.search)
  setTimeout(() => toast('Proxy and key saved from your invite link.'), 300)
})()

function proxyUrl() {
  return settings.proxy.trim() || location.origin
}

function toast(msg: string, bad = false) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'show' + (bad ? ' bad' : '')
  clearTimeout((t as any)._h)
  ;(t as any)._h = setTimeout(() => (t.className = ''), 4000)
}

function show(screen: string | null) {
  for (const s of document.querySelectorAll<HTMLElement>('.menu')) s.classList.toggle('hidden', s.id !== screen)
  document.body.classList.toggle('ingame', screen === null)
}

// ----------------------------------------------------------------- server list

function renderServers() {
  const list = $('#servers')
  list.innerHTML = ''
  if (!servers.length) {
    list.innerHTML = '<div class="empty">No servers yet. Add one below.</div>'
    return
  }
  for (const s of servers) {
    const row = document.createElement('div')
    row.className = 'server'
    row.innerHTML = `<div class="sicon"></div><div class="sinfo"><div class="sname"></div><div class="smotd">Pinging…</div></div><div class="smeta"><div class="splayers"></div><div class="sping"></div></div>
      <div class="sactions"><button class="btn primary join">Join</button><button class="btn ghost edit" title="Edit">✎</button><button class="btn ghost del" title="Remove">✕</button></div>`
    row.querySelector('.sname')!.textContent = s.name || s.address
    row.querySelector<HTMLButtonElement>('.join')!.onclick = () => join(s)
    row.ondblclick = () => join(s)
    row.querySelector<HTMLButtonElement>('.edit')!.onclick = e => { e.stopPropagation(); editServer(s) }
    row.querySelector<HTMLButtonElement>('.del')!.onclick = e => {
      e.stopPropagation()
      if (!confirm(`Remove ${s.name || s.address}?`)) return
      servers = servers.filter(x => x.id !== s.id)
      store.saveServers(servers)
      renderServers()
    }
    list.appendChild(row)
    pingInto(s, row)
  }
}

async function pingInto(s: store.ServerEntry, row: HTMLElement) {
  const motd = row.querySelector('.smotd') as HTMLElement
  const players = row.querySelector('.splayers') as HTMLElement
  const ping = row.querySelector('.sping') as HTMLElement
  if (!settings.key && !settings.proxy) { motd.textContent = 'Set up your proxy first (Settings).'; return }
  try {
    const { host, port } = store.parseAddress(s.address)
    const latest = await versions.latest()
    const data = await versions.load(latest)
    const tr = await Transport.open({ proxy: proxyUrl(), key: settings.key, host, port })
    const { status, ms } = await pingServer(tr, data.codec, host, port ?? 25565, latest.protocol)
    motd.innerHTML = ''
    motd.appendChild(toDom(status.description ?? ''))
    players.textContent = status.players ? `${status.players.online}/${status.players.max}` : ''
    const vname = status.version?.name ?? ''
    const known = (await versions.versions()).some(v => v.protocol === status.version?.protocol)
    ping.textContent = `${ms >= 0 ? ms + ' ms' : ''}${vname ? ' · ' + vname : ''}`
    ping.classList.toggle('warn', !known)
    if (!known) ping.title = 'Not a 26.x server. Joining only works if it has ViaVersion.'
    if (status.favicon) (row.querySelector('.sicon') as HTMLElement).style.backgroundImage = `url(${status.favicon})`
  } catch (e: any) {
    motd.textContent = e.message || 'Can’t reach server'
    motd.classList.add('bad')
  }
}

function editServer(s: store.ServerEntry | null) {
  const d = $<HTMLDialogElement>('#serverdlg')
  const f = d.querySelector('form')!
  ;(f.elements.namedItem('name') as HTMLInputElement).value = s?.name ?? ''
  ;(f.elements.namedItem('address') as HTMLInputElement).value = s?.address ?? ''
  d.querySelector('h2')!.textContent = s ? 'Edit server' : 'Add server'
  f.onsubmit = e => {
    e.preventDefault()
    const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim()
    const address = (f.elements.namedItem('address') as HTMLInputElement).value.trim()
    if (!address) return
    if (s) Object.assign(s, { name, address })
    else servers.push({ id: Math.random().toString(36).slice(2), name, address })
    store.saveServers(servers)
    d.close()
    renderServers()
  }
  d.showModal()
}

// ----------------------------------------------------------------- settings

function fillSettings() {
  const f = $<HTMLFormElement>('#settingsform')
  ;(f.elements.namedItem('username') as HTMLInputElement).value = settings.username
  ;(f.elements.namedItem('proxy') as HTMLInputElement).value = settings.proxy
  ;(f.elements.namedItem('proxy') as HTMLInputElement).placeholder = location.origin
  ;(f.elements.namedItem('key') as HTMLInputElement).value = settings.key
  ;(f.elements.namedItem('viewDistance') as HTMLInputElement).value = String(settings.viewDistance)
  ;(f.elements.namedItem('fov') as HTMLInputElement).value = String(settings.fov)
  ;(f.elements.namedItem('sensitivity') as HTMLInputElement).value = String(settings.sensitivity)
  $('#packname').textContent = pack ? pack.name : 'none (plain colours)'
  updateRangeLabels()
}

function updateRangeLabels() {
  const f = $<HTMLFormElement>('#settingsform')
  for (const n of ['viewDistance', 'fov', 'sensitivity']) {
    const i = f.elements.namedItem(n) as HTMLInputElement
    const out = f.querySelector(`output[for=${n}]`)
    if (out) out.textContent = n === 'sensitivity' ? Number(i.value).toFixed(2) + '×' : i.value
  }
}

function readSettings(): boolean {
  const f = $<HTMLFormElement>('#settingsform')
  const username = (f.elements.namedItem('username') as HTMLInputElement).value.trim()
  if (username && !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    toast('Usernames are 3–16 letters, numbers or _', true)
    return false
  }
  settings = {
    username,
    proxy: (f.elements.namedItem('proxy') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
    key: (f.elements.namedItem('key') as HTMLInputElement).value.trim(),
    viewDistance: Number((f.elements.namedItem('viewDistance') as HTMLInputElement).value),
    fov: Number((f.elements.namedItem('fov') as HTMLInputElement).value),
    sensitivity: Number((f.elements.namedItem('sensitivity') as HTMLInputElement).value)
  }
  store.saveSettings(settings)
  return true
}

async function testKey() {
  if (!readSettings()) return
  const out = $('#keystatus')
  out.textContent = 'Checking…'
  out.className = 'keystatus'
  try {
    const r = await Transport.check(proxyUrl(), settings.key)
    out.textContent = `✓ ${r.name}${r.key ? ` · key “${r.key}”` : ''}`
    out.className = 'keystatus ok'
  } catch (e: any) {
    out.textContent = '✕ ' + e.message
    out.className = 'keystatus bad'
  }
}

async function choosePack(file: File) {
  try {
    $('#packname').textContent = 'Reading…'
    const bytes = new Uint8Array(await file.arrayBuffer())
    pack = Pack.fromZip(bytes, file.name)
    await store.savePack(file.name, bytes)
    assetCache.clear()
    $('#packname').textContent = file.name
    toast('Textures loaded.')
  } catch (e: any) {
    $('#packname').textContent = pack ? pack.name : 'none (plain colours)'
    toast(e.message, true)
  }
}

// ----------------------------------------------------------------- joining

function setConnecting(text: string, sub = '') {
  show('connecting')
  $('#connecting h2').textContent = text
  $('#connecting p').textContent = sub
}

function showDisconnect(reason: any) {
  show('disconnected')
  const p = $('#disconnected .reason')
  p.innerHTML = ''
  p.appendChild(toDom(reason ?? 'Disconnected'))
}

async function join(s: store.ServerEntry, override?: { host: string; port: number }) {
  if (!settings.username) { toast('Pick a username in Settings first.', true); openSettings(); return }
  const parsed = store.parseAddress(s.address)
  const host = override?.host ?? parsed.host
  const portGiven = override?.port ?? parsed.port
  setConnecting('Connecting…', `${host}${portGiven ? ':' + portGiven : ''} through ${new URL(proxyUrl().match(/^[a-z]+:\/\//i) ? proxyUrl() : 'https://' + proxyUrl()).host}`)
  let tr: Transport | null = null
  try {
    // 1. ask the server which version it runs
    const latest = await versions.latest()
    const pingData = await versions.load(latest)
    const pt = await Transport.open({ proxy: proxyUrl(), key: settings.key, host, port: portGiven })
    const port = portGiven ?? pt.info?.port ?? 25565
    const { status } = await pingServer(pt, pingData.codec, host, port, latest.protocol)
    const proto = status?.version?.protocol ?? latest.protocol
    const pick = await versions.forProtocol(proto)
    if (!pick.exact) toast(`Server reports ${status?.version?.name ?? 'protocol ' + proto}; joining as ${pick.info.version}. This needs ViaVersion on the server.`)
    setConnecting('Loading game data…', `Minecraft ${pick.info.version}`)
    const [data, lang] = await Promise.all([versions.load(pick.info), versions.language()])
    setLanguage(lang)
    // 2. block models for this version + pack
    const key = pick.info.version + '|' + (pack?.name ?? '')
    let assets = assetCache.get(key)
    if (!assets) {
      assets = new BlockAssets(data.blocks)
      await assets.build(pack, t => setConnecting(t, `Minecraft ${pick.info.version}`))
      assetCache.set(key, assets)
    }
    // 3. log in
    setConnecting('Joining…', `${host}:${port}`)
    tr = await Transport.open({ proxy: proxyUrl(), key: settings.key, host, port: portGiven })
    const world = new World(data.blocks)
    if (!renderer) renderer = new Renderer(canvas, world, assets)
    else renderer.reset(world, assets)
    show(null)
    session = new Session(tr, data, renderer, assets, hud, {
      host, port, username: settings.username, viewDistance: settings.viewDistance, fov: settings.fov, sensitivity: settings.sensitivity
    })
    hud.onLeave = () => session?.leave()
    hud.onResume = () => canvas.requestPointerLock()
    session.onEnd = (reason, transfer) => {
      session = null
      hud.showPause(false)
      hud.showContainer(null, [])
      if (transfer) join(s, transfer)
      else if (reason === null) { show('main'); renderServers() }
      else showDisconnect(reason)
    }
    canvas.requestPointerLock()
  } catch (e: any) {
    tr?.close()
    const msg = e instanceof ProxyError ? e.message : e?.message || String(e)
    showDisconnect({ text: msg })
    if (e instanceof ProxyError && (e.code === 'bad_key' || e.code === 'key_required')) setTimeout(openSettings, 50)
  }
}

function openSettings() {
  fillSettings()
  show('settings')
}

// ----------------------------------------------------------------- wire up

$('#addserver').onclick = () => editServer(null)
$('#direct').onclick = () => {
  const a = prompt('Server address (host or host:port)')
  if (a) join({ id: 'direct', name: a, address: a })
}
$('#refresh').onclick = () => renderServers()
$('#opensettings').onclick = openSettings
$('#settingsback').onclick = () => { if (readSettings()) { show('main'); renderServers() } }
$('#testkey').onclick = testKey
$('#settingsform').addEventListener('input', updateRangeLabels)
$('#settingsform').addEventListener('submit', e => e.preventDefault())
$<HTMLInputElement>('#packfile').onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) choosePack(f)
}
$('#clearpack').onclick = async () => { pack = null; assetCache.clear(); await store.clearPack(); fillSettings(); toast('Using plain colours.') }
$('#discback').onclick = () => { show('main'); renderServers() }
$<HTMLDialogElement>('#serverdlg').querySelector('.cancel')!.addEventListener('click', () => $<HTMLDialogElement>('#serverdlg').close())

window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && session && hud.inventoryOpen) hud.showInventory(null)
})
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => {
  e.preventDefault()
  const f = e.dataTransfer?.files?.[0]
  if (f && /\.(jar|zip)$/i.test(f.name)) choosePack(f).then(fillSettings)
})

;(async () => {
  const saved = await store.loadPack()
  if (saved) {
    try { pack = Pack.fromZip(saved.bytes, saved.name) } catch { pack = null }
  } else {
    // the proxy owner can drop a resource pack next to the client as pack.zip
    try {
      const r = await fetch('./pack.zip')
      if (r.ok && (r.headers.get('content-type') ?? '').match(/zip|octet/)) pack = Pack.fromZip(new Uint8Array(await r.arrayBuffer()), 'pack.zip (from this site)')
    } catch {}
  }
  show(settings.username && (settings.key || settings.proxy) ? 'main' : 'settings')
  if (!settings.username || (!settings.key && !settings.proxy)) fillSettings()
  renderServers()
  try {
    const info = await (await fetch(new URL('/info', proxyUrl().match(/^https?:\/\//) ? proxyUrl() : location.origin))).json()
    if (info?.name) $('#proxyname').textContent = info.name
  } catch {}
})()

console.log('Beacon', toPlain('ready'))
