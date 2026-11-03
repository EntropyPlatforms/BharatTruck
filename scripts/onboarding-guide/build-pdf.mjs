// One common onboarding PDF from the captured guide steps (steps.json + shots/*.jpg).
// Usage: node build-pdf.mjs out.pdf
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? 'BharatTruck-Onboarding-Guide.pdf'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const steps = JSON.parse(readFileSync('steps.json', 'utf8'))
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const VERB = { click: 'Click', type: 'Type', upload: 'Upload', look: 'Look' }

// Everyone signs up the same way; show it once (the shipper's screens), worded for all roles.
const COMMON = 9
const common = steps.filter((s) => s.persona === 'shipper' && s.i < COMMON).map((s) => s.i === 1 ? {
  ...s,
  title: { en: 'Choose who you are', hi: 'चुनें कि आप कौन हैं' },
  body: {
    en: '“I ship goods” (shipper), “I drive a truck” (driver) or “I run a fleet” (fleet owner). It only decides where you start — you can do everything else later.',
    hi: '“I ship goods” (शिपर), “I drive a truck” (ड्राइवर) या “I run a fleet” (फ़्लीट मालिक)। इससे सिर्फ़ शुरुआत तय होती है।',
  },
} : s)

const parts = [
  { key: 'all', title: 'Sign up and verify your email', who: 'Everyone — shippers, drivers and fleet owners', list: common },
  { key: 'shipper', title: 'Shipper', who: 'Verify PAN and GSTIN, then post your first load', list: steps.filter((s) => s.persona === 'shipper' && s.i >= COMMON) },
  { key: 'driver', title: 'Driver', who: 'Aadhaar details, driving licence and bank account — no truck needed', list: steps.filter((s) => s.persona === 'driver' && s.i >= COMMON) },
  { key: 'fleet', title: 'Fleet owner', who: 'Set up the fleet, GSTIN and PAN, first truck and first driver', list: steps.filter((s) => s.persona === 'fleet' && s.i >= COMMON) },
]

let n = 0
const stepHtml = (s) => {
  n++
  return `<article class="step">
    <img src="${s.file}" alt="">
    <div class="txt">
      <div class="meta"><span class="num">${n}</span><span class="verb ${s.verb}">${VERB[s.verb]}</span><span class="ch">${esc(s.chapter)}</span></div>
      <h3>${esc(s.title.en)}</h3>
      <p>${esc(s.body.en)}</p>
      <p class="hi">${esc(s.body.hi)}</p>
    </div>
  </article>`
}

const LOGO = `<svg viewBox="168 198 274 276" width="44" height="44"><path fill="#fbb314" fill-rule="evenodd" d="M243 202H368Q393 202 393 227V318Q393 324 399 327L430 340Q438 344 438 352V410Q438 420 428 420H362L349 405H261L248 420H182Q172 420 172 410V352Q172 344 180 340L211 327Q218 324 218 318V227Q218 202 243 202ZM236 258H375Q381 258 381 264V306Q381 312 375 312H236Q230 312 230 306V264Q230 258 236 258ZM211 352L244 364Q250 366 250 372V385Q250 391 244 389L210 377Q205 375 205 370V357Q205 350 211 352ZM399 352L366 364Q360 366 360 372V385Q360 391 366 389L400 377Q405 375 405 370V357Q405 350 399 352Z"/><rect x="176" y="268" width="30" height="48" rx="8" fill="#fbb314"/><rect x="405" y="268" width="30" height="48" rx="8" fill="#fbb314"/><rect x="178" y="432" width="50" height="38" rx="8" fill="#fbb314"/><rect x="384" y="432" width="50" height="38" rx="8" fill="#fbb314"/></svg>`
const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Manrope, 'Nirmala UI', sans-serif; color: #14181f; font-size: 10.5pt; line-height: 1.45; }
  .cover { height: 265mm; display: flex; flex-direction: column; break-after: page; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 22pt; letter-spacing: -0.01em; }
  .brand b { color: #fbb314; }
  .cover h1 { margin: 38mm 0 0; font-size: 40pt; line-height: 1.02; letter-spacing: -0.03em; }
  .cover h1 span { color: #f2a516; }
  .cover .lede { margin-top: 8mm; font-size: 13pt; color: #475263; max-width: 150mm; }
  .cover .hero { margin-top: 12mm; width: 100%; border-radius: 10px; border: 1px solid #e3e7ee; }
  .cover .foot { margin-top: auto; display: flex; justify-content: space-between; color: #5b6676; font-size: 9.5pt; border-top: 1px solid #e3e7ee; padding-top: 4mm; }
  .howto { break-after: page; }
  h2 { font-size: 20pt; letter-spacing: -0.02em; margin: 0 0 2mm; }
  .howto ul { padding-left: 5mm; } .howto li { margin: 2mm 0; }
  .legend { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 5mm 0; }
  .legend div { border: 1px solid #e3e7ee; border-radius: 8px; padding: 3mm; font-size: 9.5pt; }
  .toc { margin-top: 6mm; border: 1px solid #e3e7ee; border-radius: 10px; padding: 4mm 6mm; }
  .toc div { display: flex; justify-content: space-between; padding: 1.5mm 0; border-bottom: 1px dashed #e3e7ee; }
  .toc div:last-child { border: 0; }
  .part { break-before: page; }
  .part-head { background: #fff8e8; border: 1px solid #fcdd8f; border-radius: 12px; padding: 4mm 6mm; margin-bottom: 4mm; }
  .part-head .k { font-size: 9pt; font-weight: 700; color: #8f570b; text-transform: uppercase; letter-spacing: 0.08em; }
  .part-head h2 { margin: 1mm 0 0; }
  .part-head p { margin: 1mm 0 0; color: #475263; }
  .step { break-inside: avoid; margin: 0 auto 3mm; width: 118mm; }
  .step img { width: 100%; border-radius: 8px; border: 1px solid #cbd2dc; display: block; }
  .txt { padding: 2.5mm 1mm 0; }
  .meta { display: flex; align-items: center; gap: 2mm; font-size: 8.5pt; font-weight: 700; }
  .num { background: #f2a516; color: #14181f; border-radius: 50%; width: 6mm; height: 6mm; display: inline-grid; place-items: center; font-size: 8.5pt; }
  .verb { border-radius: 4px; padding: 0.5mm 2mm; background: #eef3ff; color: #1d47d1; }
  .verb.upload { background: #e8f6ef; color: #12805c; } .verb.type { background: #f1edfd; color: #6d4bd8; } .verb.look { background: #eef1f5; color: #475263; }
  .ch { color: #8a95a5; font-weight: 600; }
  .step h3 { margin: 1.5mm 0 0; font-size: 12.5pt; letter-spacing: -0.01em; }
  .step p { margin: 1mm 0 0; color: #343d4b; }
  .step p.hi { color: #5b6676; font-size: 9.5pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 9.5pt; }
  th, td { text-align: left; padding: 2.5mm; border-bottom: 1px solid #e3e7ee; vertical-align: top; }
  th { background: #f5f7fa; }
</style></head><body>
<section class="cover">
  <div class="brand">${LOGO}<span>Bharat<b>Truck</b></span></div>
  <h1>Getting started on<br><span>BharatTruck</span></h1>
  <p class="lede">A screen-by-screen guide to signing up as a shipper, driver or fleet owner — where to click, what to type and which documents to upload.</p>
  <img class="hero" src="${parts[1].list.find((s) => s.verb === 'upload')?.file ?? common[0].file}" alt="">
  <div class="foot"><span>Interactive version: www.bharattruck.net/guide</span><span>${today}</span></div>
</section>
<section class="howto">
  <h2>How to read this guide</h2>
  <p>Every picture is the real BharatTruck screen. The part you need is lit up, with an arrow and a label telling you what to do:</p>
  <div class="legend">
    <div><b>Click</b><br>press the button or link</div><div><b>Type</b><br>fill in the field</div>
    <div><b>Upload</b><br>photograph the document; fields fill in</div><div><b>Look</b><br>read what the screen shows</div>
  </div>
  <ul>
    <li><b>All names, numbers and documents are demo data.</b> Sample documents are marked SPECIMEN. Use your own when you sign up.</li>
    <li>Only your <b>email</b> is verified at sign-up, with a 6-digit code.</li>
    <li>A <b>verified PAN</b> is needed before posting a load or bidding on one; a <b>GSTIN</b> is needed before posting a load or adding a truck.</li>
    <li>Prefer to try it yourself? Open <b>www.bharattruck.net/guide</b> — it plays these same steps, in English or Hindi.</li>
  </ul>
  <div class="toc">${parts.map((p, k) => `<div><span><b>${k === 0 ? 'Part 1' : `Part ${k + 1}`} · ${esc(p.title)}</b> — ${esc(p.who)}</span><span>${p.list.length} steps</span></div>`).join('')}</div>
</section>
${parts.map((p, k) => `<section class="part">
  <div class="part-head"><div class="k">Part ${k + 1}</div><h2>${esc(p.title)}</h2><p>${esc(p.who)}</p></div>
  ${p.list.map(stepHtml).join('')}
</section>`).join('')}
<section class="part">
  <div class="part-head"><div class="k">Reference</div><h2>What each role needs</h2><p>The checks that unlock each part of BharatTruck.</p></div>
  <table>
    <tr><th>Before you can…</th><th>You need</th><th>Where</th></tr>
    <tr><td>Use the app</td><td>Your email verified with the 6-digit code</td><td>Right after “Create account”</td></tr>
    <tr><td>Post a load</td><td>A verified PAN and a GSTIN on file</td><td>Settings → PAN, Your GSTIN</td></tr>
    <tr><td>Bid on a load</td><td>A verified PAN</td><td>Settings → PAN</td></tr>
    <tr><td>Add a truck</td><td>Fleet management set up, and a GSTIN on file</td><td>Home → “Set up fleet management”; Settings → Your GSTIN</td></tr>
    <tr><td>Drive and get paid</td><td>Driving licence submitted (verified by our team) and a bank account linked</td><td>Driver profile</td></tr>
    <tr><td>Drive for a fleet</td><td>A BharatTruck account; then accept the fleet’s invitation</td><td>Home → invitation card → Accept</td></tr>
  </table>
  <p style="margin-top:6mm;color:#5b6676">Documents you may be asked for: PAN card, GST registration certificate (REG-06), Aadhaar card (driver name and city — the number is not kept), driving licence, a cancelled cheque or passbook page, and each truck’s RC.</p>
</section>
</body></html>`

writeFileSync('guide.html', html)
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage()
await page.goto(new URL('guide.html', `file:///${process.cwd().replace(/\\/g, '/')}/`).href, { waitUntil: 'networkidle0' })
await page.pdf({
  path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font-size:8px;color:#8a95a5;padding:0 14mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>BharatTruck · Onboarding guide · demo data</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
})
await browser.close()
console.log('wrote', OUT, `(${n} steps)`)
