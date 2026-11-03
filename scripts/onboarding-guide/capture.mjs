// Walk every step of every persona in the guide's screenshot mode: check each step's target is
// on screen, and save a 1280×800 PNG of the canvas plus the step text (steps.json).
// Usage: node capture.mjs http://localhost:3123
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:3123'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
mkdirSync('shots', { recursive: true })

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--hide-scrollbars'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1.5 })

const out = []
let missing = 0
for (const p of ['shipper', 'driver', 'fleet']) {
  for (let i = 0; ; i++) {
    await page.goto(`${BASE}/guide?p=${p}&s=${i}&shot=1`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#guide-step')
    await new Promise((r) => setTimeout(r, 350)) // spotlight measures after layout + images
    const meta = await page.$eval('#guide-step', (el) => ({ found: el.dataset.found === '1', ...JSON.parse(el.dataset.json) }))
    if (meta.i !== i) break // past the last step (the guide clamps the index)
    const file = `shots/${p}-${String(i).padStart(2, '0')}.jpg`
    const canvas = await page.$('#guide-canvas')
    await canvas.screenshot({ path: file, type: 'jpeg', quality: 86 })
    if (!meta.found) { missing++; console.log(`MISSING target ${p} #${i} (${meta.target})`) }
    out.push({ ...meta, file })
    if (i + 1 >= meta.total) break
  }
  console.log(`${p}: ${out.filter((s) => s.persona === p).length} steps`)
}
writeFileSync('steps.json', JSON.stringify(out, null, 1))
await browser.close()
console.log(`RESULT: ${missing ? 'FAIL' : 'PASS'} — ${out.length} steps captured, ${missing} without a target`)
process.exit(missing ? 1 : 0)
