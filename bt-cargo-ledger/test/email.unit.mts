/**
 * POD email transport — sender selection + SMTP field mapping.
 * Pure unit test: no network, no Redis. The injectable transport seam on
 * SmtpEmailSender lets us assert what would go over SMTP without sending.
 * Guards the bt-auth-service env contract (EMAIL_DEV_MODE / SMTP_USER) that
 * decides whether prod mail actually leaves the box.
 * Run: npx tsx test/email.unit.mts
 */
import {
  ConsoleEmailSender,
  SmtpEmailSender,
  defaultEmailSender,
  buildOtpEmail,
} from '../src/lib/email.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const SMTP_KEYS = [
  'EMAIL_DEV_MODE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST',
  'SMTP_PORT', 'SMTP_FROM', 'POD_EMAIL_FROM', 'RECEIVER_APP_BASE_URL',
] as const

function withEnv(vars: Partial<Record<(typeof SMTP_KEYS)[number], string>>, fn: () => void) {
  const saved = Object.fromEntries(SMTP_KEYS.map(k => [k, process.env[k]]))
  SMTP_KEYS.forEach(k => delete process.env[k])
  Object.entries(vars).forEach(([k, v]) => { process.env[k] = v })
  try { fn() } finally {
    SMTP_KEYS.forEach(k => delete process.env[k])
    Object.entries(saved).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v })
  }
}

/** Captures sendMail() args in place of a real nodemailer transport. */
function fakeTransport() {
  const sent: any[] = []
  return { sent, transport: { sendMail: async (m: any) => { sent.push(m); return m } } as any }
}

async function main() {
  console.log('\n── sender selection (bt-auth-service env contract) ──')

  withEnv({}, () => {
    check('no SMTP_USER -> ConsoleEmailSender (dev default)',
      defaultEmailSender() instanceof ConsoleEmailSender)
  })

  withEnv({ SMTP_USER: 'ops@example.com', SMTP_PASS: 'x' }, () => {
    check('SMTP_USER set -> SmtpEmailSender (prod)',
      defaultEmailSender() instanceof SmtpEmailSender)
  })

  withEnv({ SMTP_USER: 'ops@example.com', SMTP_PASS: 'x', EMAIL_DEV_MODE: 'true' }, () => {
    check('EMAIL_DEV_MODE=true overrides credentials -> Console',
      defaultEmailSender() instanceof ConsoleEmailSender)
  })

  withEnv({ SMTP_USER: 'ops@example.com', SMTP_PASS: 'x', EMAIL_DEV_MODE: 'false' }, () => {
    check('EMAIL_DEV_MODE=false still sends -> Smtp',
      defaultEmailSender() instanceof SmtpEmailSender)
  })

  console.log('\n── From-address precedence ──')

  const fromOf = (s: any) => (s as any).from

  withEnv({ SMTP_USER: 'user@x.com', SMTP_PASS: 'x' }, () => {
    check('falls back to SMTP_USER when nothing else set',
      fromOf(defaultEmailSender()) === 'user@x.com')
  })

  withEnv({ SMTP_USER: 'user@x.com', SMTP_PASS: 'x', SMTP_FROM: 'from@x.com' }, () => {
    check('SMTP_FROM beats SMTP_USER',
      fromOf(defaultEmailSender()) === 'from@x.com')
  })

  withEnv({
    SMTP_USER: 'user@x.com', SMTP_PASS: 'x',
    SMTP_FROM: 'from@x.com', POD_EMAIL_FROM: 'pod@x.com',
  }, () => {
    check('POD_EMAIL_FROM wins over both',
      fromOf(defaultEmailSender()) === 'pod@x.com')
  })

  console.log('\n── SMTP field mapping ──')

  const { sent, transport } = fakeTransport()
  const sender = new SmtpEmailSender('pod@bharattruck.in', transport)
  const msg = buildOtpEmail('receiver@example.com', '123456', 10, 'bk-1')
  await sender.send(msg)

  check('exactly one message sent', sent.length === 1, String(sent.length))
  check('from is the configured sender', sent[0]?.from === 'pod@bharattruck.in')
  check('to is the receiver', sent[0]?.to === 'receiver@example.com')
  check('subject carried through', sent[0]?.subject === msg.subject)
  check('text carried through', sent[0]?.text === msg.text)
  check('html carried through', sent[0]?.html === msg.html)
  check('OTP present in body', String(sent[0]?.text).includes('123456'))

  console.log('\n── OTP email body (link vs code-only) ──')

  withEnv({ RECEIVER_APP_BASE_URL: 'https://shipper.example.com/' }, () => {
    const m = buildOtpEmail('r@example.com', '654321', 10, 'bk-2')
    check('link included when RECEIVER_APP_BASE_URL set',
      m.text.includes('https://shipper.example.com/pod/bk-2'))
    check('trailing slash normalised (no //pod)', !m.text.includes('.com//pod'))
  })

  withEnv({}, () => {
    const m = buildOtpEmail('r@example.com', '654321', 10, 'bk-3')
    check('degrades to code-only when base URL unset', !m.text.includes('/pod/'))
    check('code still present in fallback copy', m.text.includes('654321'))
  })

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
