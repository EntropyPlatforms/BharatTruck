// The portal's three pages share this script: <body data-view="all | shipper | driver">.
// "all" is the full test report; the other two show the scenarios from one user's side.
const VIEW = document.body.dataset.view || 'all'
const PERSONA = {
  shipper: { title: 'Shipper scenarios', who: 'the shipper', intro: 'What a shipper does and sees for one load: posting it, reading the bids, awarding the lowest, following the trip, the delivery being confirmed with the receiver\'s code, and payment. It also shows what a shipper is NOT allowed to do, and what other people cannot do to a shipper\'s load.' },
  driver: { title: 'Driver scenarios', who: 'the driver', intro: 'What a driver (carrier) does and sees for one load: bidding, winning or losing, the document checks at pickup, starting the trip, asking for the delivery code at the drop, and getting paid. It also shows what a driver is NOT allowed to do, such as starting a trip they did not win or marking their own trip delivered.' },
}
/** The steps of a scenario that belong to this page (all of them on the full report). */
const stepsFor = x => VIEW === 'all' ? x.steps : x.steps.filter(s => (s.views ?? ['shipper', 'driver']).includes(VIEW))

const LABEL = { pass: 'Passed', fail: 'Failed', warn: 'Warning', skip: 'Skipped', not_run: 'Not run' }
const GROUPS = { api: 'API and access control', web: 'Pages and assets', browser: 'In a real browser', 'signed-in': 'Signed-in journey' }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const badge = s => `<span class="b b-${s}">${LABEL[s] ?? esc(s)}</span>`
const secs = ms => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
const when = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST'
const TRIGGER = { push: 'a release', workflow_run: 'a release', schedule: 'the daily schedule', workflow_dispatch: 'a manual run', manual: 'a manual run' }

// Cities for the "Try your own scenario" form. state_code is the GST state code (it decides
// whether the pickup gate asks for an e-way bill).
const CITIES = [
  ['Ahmedabad, Gujarat', 23.0225, 72.5714, '24'], ['Bengaluru, Karnataka', 12.9716, 77.5946, '29'],
  ['Bhopal, Madhya Pradesh', 23.2599, 77.4126, '23'], ['Chennai, Tamil Nadu', 13.0827, 80.2707, '33'],
  ['Delhi', 28.6139, 77.209, '07'], ['Hyderabad, Telangana', 17.385, 78.4867, '36'],
  ['Indore, Madhya Pradesh', 22.7196, 75.8577, '23'], ['Jaipur, Rajasthan', 26.9124, 75.7873, '08'],
  ['Kolkata, West Bengal', 22.5726, 88.3639, '19'], ['Lucknow, Uttar Pradesh', 26.8467, 80.9462, '09'],
  ['Mumbai, Maharashtra', 19.076, 72.8777, '27'], ['Nagpur, Maharashtra', 21.1458, 79.0882, '27'],
  ['Nashik, Maharashtra', 19.9975, 73.7898, '27'], ['Patna, Bihar', 25.5941, 85.1376, '10'],
  ['Pune, Maharashtra', 18.5204, 73.8567, '27'], ['Raipur, Chhattisgarh', 21.2514, 81.6296, '22'],
  ['Surat, Gujarat', 21.1702, 72.8311, '24'], ['Visakhapatnam, Andhra Pradesh', 17.6868, 83.2185, '37'],
].map(([label, lat, lng, state_code]) => ({ label, lat, lng, state_code }))

/** One scenario's steps as a table, grouped by stage (shared by saved and custom scenarios). */
function stepsTable(x) {
  const steps = stepsFor(x)
  const stages = [...new Set(steps.map(s => s.stage))]
  return `<table><tbody>${stages.map(stage => `<tr><td colspan="4" class="stage">${esc(stage)}</td></tr>` + steps.map((s, i) => s.stage !== stage ? '' :
    `<tr><td>${i + 1}. ${esc(s.title)}</td><td class="who">${esc(s.actor)}</td><td class="d">${esc(s.got)}</td><td>${badge(s.ok ? 'pass' : 'fail')}</td></tr>`).join('')).join('')}</tbody></table>`
}

function wireScenarioForm(runnerUrl) {
  const form = document.getElementById('sc-form')
  if (!form) return
  const rows = document.getElementById('bid-rows')
  const msg = document.getElementById('run-msg')
  const addBid = (carrier = '', amount = '') => {
    if (rows.children.length >= 6) return
    const row = document.createElement('div')
    row.className = 'bid-row'
    row.innerHTML = `<input placeholder="Carrier name" maxlength="40" class="b-name" value="${esc(carrier)}" required>
      <input placeholder="Bid (₹)" type="number" min="1" step="1" class="b-amt" value="${esc(amount)}" required>
      <button type="button" class="btn small" aria-label="Remove this bid">Remove</button>`
    row.querySelector('button').onclick = () => { if (rows.children.length > 1) row.remove() }
    rows.appendChild(row)
  }
  addBid('Sharma Transport', 46200); addBid('Vidarbha Roadlines', 47500)
  document.getElementById('add-bid').onclick = () => addBid()

  form.onsubmit = async ev => {
    ev.preventDefault()
    if (!form.reportValidity()) return
    const f = new FormData(form)
    const scenario = {
      from: CITIES[Number(f.get('from'))], to: CITIES[Number(f.get('to'))],
      weight_kg: Math.round(Number(f.get('weight_t')) * 1000),
      vehicle_type: f.get('vehicle_type'), load_type: 'general',
      quoted_price: Math.round(Number(f.get('quoted_price'))),
      consignment_value_inr: Number(f.get('consignment_value_inr')),
      receiver: { name: f.get('receiver_name'), phone: f.get('receiver_phone'), email: f.get('receiver_email') },
      bids: [...rows.children].map(r => ({ carrier: r.querySelector('.b-name').value.trim(), amount: Math.round(Number(r.querySelector('.b-amt').value)) })),
    }
    const btn = document.getElementById('run-btn')
    const out = document.getElementById('sc-result')
    btn.disabled = true; msg.textContent = 'Playing the load… (the first run after a quiet spell can take up to 30 seconds)'
    try {
      const res = await fetch(runnerUrl.replace(/\/$/, '') + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) })
      const body = await res.json()
      if (!body.success) { msg.textContent = body.error || 'The scenario could not be played.'; out.innerHTML = ''; return }
      const x = body.data
      msg.textContent = ''
      out.innerHTML = `<div class="result-head">${badge(x.status)} <b>${esc(x.summary)}</b><span class="nums">${stepsFor(x).filter(s => s.ok).length} of ${stepsFor(x).length} steps as expected · ended ${esc(x.final_status)}</span></div>${stepsTable(x)}`
      out.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch {
      msg.textContent = 'Could not reach the scenario runner. Try again in a moment.'
    } finally {
      btn.disabled = false
    }
  }
}

function render(r) {
  const t = r.totals
  document.getElementById('app-link').href = r.target.app
  document.getElementById('meta').textContent =
    `Last run ${when(r.generated_at)} · started by ${TRIGGER[r.run.trigger] ?? r.run.trigger}` + (r.run.commit ? ` · version ${r.run.commit.slice(0, 7)}` : '')
  const extras = [t.skipped ? `${t.skipped} skipped` : '', t.warnings ? `${t.warnings} warning${t.warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')

  const packages = r.packages.map(p => `
    <details class="card"${p.status !== 'pass' ? ' open' : ''}>
      <summary>
        <span class="name">${esc(p.name)}<span class="about">${esc(p.about)}</span></span>
        <span class="nums">${p.totals.test_files} files · ${p.totals.assertions || '—'} assertions · ${secs(p.duration_ms)}</span>
        ${badge(p.status)}
      </summary>
      ${p.checks.length === 0 ? '<p class="hint">This suite did not run in the latest pipeline.</p>' : `<table>
        <thead><tr><th>Check</th><th>Result</th><th class="n">Assertions</th><th class="n">Time</th></tr></thead>
        <tbody>${p.checks.map(c => `<tr><td>${esc(c.name)}${c.status !== 'pass' && c.output_tail ? `<pre>${esc(c.output_tail)}</pre>` : ''}</td><td>${badge(c.status)}</td><td class="n">${c.assertions ?? '—'}</td><td class="n">${secs(c.duration_ms)}</td></tr>`).join('')}</tbody>
      </table>`}
    </details>`).join('')

  const e2e = r.e2e.checks.length === 0 ? '<div class="card"><p class="state">The end-to-end checks did not run.</p></div>' :
    '<div class="card">' + Object.entries(GROUPS).map(([g, title]) => {
      const list = r.e2e.checks.filter(c => c.group === g)
      return list.length === 0 ? '' : `<div class="group">${title}</div><table><tbody>${list.map(c =>
        `<tr><td>${esc(c.name)}</td><td>${badge(c.status)}</td><td class="d">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>`
    }).join('') + '</div>'

  const sc = r.scenarios ?? { list: [], totals: { scenarios: 0, passed: 0 } }
  const scenarios = sc.list.length === 0 ? '<div class="card"><p class="state">The scenarios did not run in the latest pipeline.</p></div>' : sc.list.map((x, n) => {
    return `<details class="card"${n === 0 || x.status !== 'pass' ? ' open' : ''}>
      <summary>
        <span class="name">${esc(x.name)}<span class="about">${esc(x.summary)}</span></span>
        <span class="nums">${stepsFor(x).filter(s => s.ok).length} of ${stepsFor(x).length} steps · ended ${esc(x.final_status)}</span>
        ${badge(stepsFor(x).every(s => s.ok) ? 'pass' : 'fail')}
      </summary>
      ${stepsTable(x)}
    </details>`
  }).join('')

  const tryIt = `
    <div class="card" id="try">
      ${r.runner_url ? `
      <form id="sc-form" class="form" novalidate>
        <div class="grid3">
          <label>Pickup city<select name="from">${CITIES.map((c, i) => `<option value="${i}"${c.label.startsWith('Nagpur') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          <label>Drop city<select name="to">${CITIES.map((c, i) => `<option value="${i}"${c.label.startsWith('Pune') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          <label>Truck type<select name="vehicle_type"><option value="mini_truck">Mini truck</option><option value="lcv">LCV</option><option value="hcv" selected>HCV</option><option value="trailer">Trailer</option></select></label>
          <label>Weight (tonnes)<input name="weight_t" type="number" min="0.1" max="60" step="0.1" value="16" required></label>
          <label>Quoted price (₹)<input name="quoted_price" type="number" min="1" step="1" value="48500" required></label>
          <label>Value of goods (₹)<input name="consignment_value_inr" type="number" min="0" step="1" value="40000" required></label>
          <label>Receiver name<input name="receiver_name" maxlength="60" value="Anita Traders" required></label>
          <label>Receiver mobile<input name="receiver_phone" inputmode="numeric" maxlength="10" value="9876543210" required></label>
          <label>Receiver email<input name="receiver_email" type="email" maxlength="120" value="stores@anita-traders.example" required></label>
        </div>
        <div class="bids">
          <span class="bids-title">Bids <span class="about" style="display:inline">(1 to 6 carriers; the lowest wins)</span></span>
          <div id="bid-rows"></div>
          <button type="button" class="btn small" id="add-bid">+ Add a bid</button>
        </div>
        <div class="run-row">
          <button type="submit" class="btn primary" id="run-btn">Run this scenario</button>
          <span id="run-msg" class="about" style="display:inline"></span>
        </div>
      </form>
      <div id="sc-result"></div>` : `<p class="state">The scenario runner is not available right now. The saved scenarios above still run on every pipeline run.</p>`}
    </div>
`

  // ── Shipper / Driver pages: the scenarios from one side only ──
  if (VIEW !== 'all') {
    const p = PERSONA[VIEW]
    document.querySelector('h1').textContent = p.title
    document.querySelector('.lede').textContent = p.intro
    document.title = `BharatTruck — ${p.title}`
    document.getElementById('root').innerHTML = `
      <h2>Saved scenarios</h2>
      <p class="sub">Played on every test run, through the real booking and delivery-code code on a practice copy, never the live site. Only the steps that concern ${p.who} are shown here; the <a href="./">full report</a> has every step.</p>
      ${scenarios}
      <h2>Try your own scenario</h2>
      <p class="sub">Describe a load and press Run to see it from ${p.who}'s side. Nothing is created on the live site, and nothing you type is saved.</p>
      ${tryIt}`
    if (r.runner_url) wireScenarioForm(r.runner_url)
    return
  }

  const history = r.history.length < 2 ? '' : `
    <h2>Recent runs</h2>
    <p class="sub">Newest on the left. Green passed, red had a failure.</p>
    <div class="card"><div class="history">${r.history.map(h =>
      `<a class="dot ${h.status}" href="${esc(h.run_url || '#')}" target="_blank" rel="noopener" title="${esc(when(h.finished_at))} — ${h.passed}/${h.checks} passed${h.failed ? `, ${h.failed} failed` : ''}"></a>`).join('')}</div>
    <p class="hint">${r.history.filter(h => h.status === 'pass').length} of the last ${r.history.length} runs passed.</p></div>`

  document.getElementById('root').innerHTML = `
    <div class="verdict ${r.status}">
      <strong>${r.status === 'pass' ? `All checks passed — ${t.passed} of ${t.checks}` : `${t.failed} of ${t.checks} checks failed`}${extras ? ` <span style="font-weight:600;font-size:14px">· ${extras}</span>` : ''}</strong>
      <span class="actions">
        <a class="btn primary" href="report.pdf" download="bharattruck-test-report.pdf">Download PDF report</a>
        <a class="btn" href="report.html" target="_blank" rel="noopener">Printable view</a>
      </span>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${t.packages_passed} / ${t.packages}</b><span>services and apps green</span></div>
      <div class="kpi"><b>${t.test_files}</b><span>test files run</span></div>
      <div class="kpi"><b>${t.assertions.toLocaleString('en-IN')}</b><span>individual assertions</span></div>
      <div class="kpi"><b>${t.e2e_passed} / ${t.e2e_checks}</b><span>live end-to-end checks</span></div>
    </div>
    <h2>Services and apps</h2>
    <p class="sub">Each one is compiled and type-checked, then every test file is run on its own. Click a row for its checks.</p>
    ${packages}
    <h2>End-to-end checks on the live site</h2>
    <p class="sub">Run against <a href="${esc(r.target.app)}" target="_blank" rel="noopener">${esc(r.target.app.replace('https://', ''))}</a>, read-only.</p>
    ${e2e}
    <h2>Scenarios: one load from posting to payment</h2>
    <p class="sub">Each scenario plays a full load through the real booking and delivery-code code: posted, bid on, awarded, picked up, delivered with the receiver's code, and paid, with the access rules checked at every stage. It runs on a throwaway copy, never on the live site. ${sc.totals.passed} of ${sc.totals.scenarios} scenarios passed.</p>
    <div class="personas">
      <a class="card persona" href="shipper.html"><b>Shipper's side →</b><span>Posting, reading bids, awarding, following the trip, delivery and payment.</span></a>
      <a class="card persona" href="driver.html"><b>Driver's side →</b><span>Bidding, winning or losing, pickup checks, the delivery code and getting paid.</span></a>
    </div>
    ${scenarios}
    <h2>Try your own scenario</h2>
    <p class="sub">Describe a load and press Run. It is played from posting to payment through the same real code, on a throwaway copy: nothing is created on the live site, and nothing you type is saved.</p>
    ${tryIt}
    ${history}
    ${r.run.url ? `<p class="hint" style="padding:14px 0 0">Full log of this run: <a href="${esc(r.run.url)}" target="_blank" rel="noopener">GitHub Actions run #${r.run.number}</a> (needs access to the repository).</p>` : ''}`
  if (r.runner_url) wireScenarioForm(r.runner_url)
}

fetch('report.json', { cache: 'no-store' })
  .then(res => { if (!res.ok) throw new Error(res.status); return res.json() })
  .then(render)
  .catch(() => {
    document.getElementById('meta').textContent = ''
    document.getElementById('root').innerHTML = '<div class="card"><p class="state">No test run has been published yet. The first report appears here when the test pipeline finishes.</p></div>'
  })
