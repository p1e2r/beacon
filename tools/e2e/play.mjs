import { chromium } from 'playwright'
import fs from 'node:fs'
const key = fs.readFileSync('key.txt', 'utf8').match(/bk_[A-Za-z0-9_-]+/)[0]
const base = process.env.BASE || 'http://127.0.0.1:8080'
const shot = process.env.SHOT || 'shot'

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))

await page.goto(`${base}/#proxy=${encodeURIComponent(base)}&key=${key}`)
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('beacon.settings') || '{}')
  localStorage.setItem('beacon.settings', JSON.stringify({ ...s, username: 'Tester', viewDistance: 4 }))
  localStorage.setItem('beacon.servers', JSON.stringify([{ id: 'a', name: 'Local fixture', address: '127.0.0.1:25599' }, { id: 'b', name: 'Nowhere', address: '127.0.0.1:1' }]))
})
await page.reload()
await page.waitForTimeout(2500)
await page.screenshot({ path: `${shot}-menu.png` })
await page.click('.server .join')
await page.waitForTimeout(9000)
await page.screenshot({ path: `${shot}-ingame.png` })
// chat + command
await page.keyboard.press('KeyT')
await page.waitForTimeout(200)
await page.keyboard.type('hello from the browser')
await page.keyboard.press('Enter')
await page.waitForTimeout(300)
await page.keyboard.press('Slash')
await page.waitForTimeout(200)
await page.keyboard.type('login secret123')
await page.keyboard.press('Enter')
await page.waitForTimeout(500)
// walk forward a bit + debug overlay
await page.keyboard.press('F3')
await page.keyboard.down('KeyW')
await page.waitForTimeout(1500)
await page.keyboard.up('KeyW')
await page.waitForTimeout(800)
await page.screenshot({ path: `${shot}-walk.png` })
fs.writeFileSync(`${shot}-console.txt`, logs.join('\n'))
await browser.close()
console.log(logs.filter(l => /error|warn|pageerror/i.test(l)).slice(0, 30).join('\n') || 'no errors in console')
