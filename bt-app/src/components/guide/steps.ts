// The onboarding guide's script: one list of steps per persona, each pointing at a real control
// on a re-drawn app screen (data-guide ids in screens.tsx). Text and labels follow the live app
// (login/page.tsx, settings, driver-profile, vehicles, drivers, post) so the guide matches what
// a new user will actually see. All data is DEMO data — never a real person or document.

export type Persona = 'shipper' | 'driver' | 'fleet'
export type Screen = 'landing' | 'register' | 'verify' | 'home' | 'settings' | 'post' | 'driver-profile' | 'vehicles' | 'drivers' | 'done'
export type Dialog = 'add-truck' | 'invite' | null
export type DocKind = 'aadhaar' | 'pan' | 'licence' | 'cheque' | 'gst' | 'rc'
export type Verb = 'click' | 'type' | 'upload' | 'look'
export type L = { en: string; hi: string }

export type DemoState = {
  f: Record<string, string>    // field values
  on: Record<string, boolean>  // things done (pan verified, truck added, …)
}

export type Step = {
  id: string
  chapter: string
  screen: Screen
  dialog?: Dialog
  target: string
  verb: Verb
  title: L
  body: L
  doc?: DocKind
  /** Field typed on "do it": key + value (animated). */
  type?: [string, string]
  /** Everything else the step fills or turns on once done. */
  fill?: Record<string, string>
  set?: string[]
  /** Toast shown after the step is done (the live app's own wording). */
  toast?: string
}

export const PERSONA_META: Record<Persona, { label: L; who: string; role: string; blurb: L }> = {
  shipper: {
    label: { en: 'Shipper', hi: 'शिपर (माल भेजने वाले)' },
    who: 'Anita Sharma', role: 'I ship goods',
    blurb: { en: 'You send goods and want trucks to bid on your loads.', hi: 'आप माल भेजते हैं और चाहते हैं कि ट्रक आपके लोड पर बोली लगाएँ।' },
  },
  driver: {
    label: { en: 'Driver', hi: 'ड्राइवर' },
    who: 'Ramesh Yadav', role: 'I drive a truck',
    blurb: { en: 'You drive a truck — just your driving licence to start, no truck needed.', hi: 'आप ट्रक चलाते हैं — शुरू करने के लिए सिर्फ़ ड्राइविंग लाइसेंस चाहिए, ट्रक नहीं।' },
  },
  fleet: {
    label: { en: 'Fleet owner', hi: 'फ़्लीट मालिक' },
    who: 'Rajesh Sharma', role: 'I run a fleet',
    blurb: { en: 'You own trucks, employ drivers and bid on loads.', hi: 'आपके पास ट्रक हैं, ड्राइवर हैं और आप लोड पर बोली लगाते हैं।' },
  },
}

/** Demo identities — clearly fictional, used on the sample documents too. */
export const DEMO = {
  shipper: { name: 'Anita Sharma', email: 'anita@example.com', company: 'Anita Exports', pan: 'AABCU9603R', gstin: '29AABCU9603R1ZM', dob: '1988-04-12' },
  driver: { name: 'Ramesh Yadav', email: 'ramesh@example.com', city: 'Nagpur', aadhaarLast4: '4821', dl: 'MH3120190012345', dlValid: '2031-08-14', account: '50100234567891', ifsc: 'HDFC0001234', bank: 'HDFC Bank' },
  fleet: { name: 'Rajesh Sharma', email: 'rajesh@example.com', company: 'Sharma Roadlines', pan: 'AAPFU0939F', gstin: '27AAPFU0939F1ZV', rc: 'MH31CQ4512', driverPhone: '9876543210' },
} as const

const CODE = '482913'

function signUp(p: Persona): Step[] {
  const d = DEMO[p]
  const row = PERSONA_META[p].role
  return [
    {
      id: 'landing', chapter: 'Sign up', screen: 'landing', target: 'create-account', verb: 'click',
      title: { en: 'Open BharatTruck', hi: 'BharatTruck खोलें' },
      body: { en: 'Go to www.bharattruck.net and click “Create account” at the top right.', hi: 'www.bharattruck.net पर जाएँ और ऊपर दाईं ओर “Create account” पर क्लिक करें।' },
    },
    {
      id: 'persona', chapter: 'Sign up', screen: 'register', target: `persona-${p}`, verb: 'click',
      title: { en: `Choose “${row}”`, hi: `“${row}” चुनें` },
      body: {
        en: 'Tell BharatTruck who you are. It only decides where you start — you can still do everything else later.',
        hi: 'बताइए आप कौन हैं। इससे सिर्फ़ यह तय होता है कि आप कहाँ से शुरू करेंगे — बाकी सब बाद में भी कर सकते हैं।',
      },
      set: [`persona-${p}`],
    },
    {
      id: 'name', chapter: 'Sign up', screen: 'register', target: 'full-name', verb: 'type',
      title: { en: 'Type your full name', hi: 'अपना पूरा नाम लिखें' },
      body: { en: 'Use the name people will see on bids, trips and invoices.', hi: 'वही नाम लिखें जो बोली, ट्रिप और बिल पर दिखेगा।' },
      type: ['name', d.name],
    },
    {
      id: 'email', chapter: 'Sign up', screen: 'register', target: 'email', verb: 'type',
      title: { en: 'Type your email', hi: 'अपना ईमेल लिखें' },
      body: { en: 'A 6-digit code will be sent here to verify it is yours.', hi: 'इस ईमेल पर 6 अंकों का कोड आएगा, ताकि पता चले कि ईमेल आपका है।' },
      type: ['email', d.email],
    },
    {
      id: 'password', chapter: 'Sign up', screen: 'register', target: 'password', verb: 'type',
      title: { en: 'Create a password', hi: 'पासवर्ड बनाएँ' },
      body: { en: 'At least 8 characters. The bar under it turns green when the password is strong.', hi: 'कम से कम 8 अक्षर। पासवर्ड मज़बूत होने पर नीचे की पट्टी हरी हो जाती है।' },
      type: ['password', 'Truck@2026safe'],
    },
    {
      id: 'create', chapter: 'Sign up', screen: 'register', target: 'create', verb: 'click',
      title: { en: 'Click “Create account”', hi: '“Create account” पर क्लिक करें' },
      body: { en: 'Your account is created and a code is emailed to you.', hi: 'आपका अकाउंट बन जाता है और ईमेल पर कोड भेजा जाता है।' },
      toast: `We sent a 6-digit code to ${d.email}.`,
    },
    {
      id: 'code', chapter: 'Verify email', screen: 'verify', target: 'code', verb: 'type',
      title: { en: 'Enter the 6-digit code', hi: '6 अंकों का कोड डालें' },
      body: { en: 'Open your email and type the code. Did not get it? Use “Resend code”.', hi: 'ईमेल खोलें और कोड डालें। नहीं मिला? “Resend code” दबाएँ।' },
      type: ['code', CODE],
    },
    {
      id: 'verify', chapter: 'Verify email', screen: 'verify', target: 'verify', verb: 'click',
      title: { en: 'Click “Verify & continue”', hi: '“Verify & continue” पर क्लिक करें' },
      body: { en: 'Your email is verified and you are signed in.', hi: 'आपका ईमेल वेरिफ़ाई हो गया और आप साइन इन हो गए।' },
    },
    {
      id: 'home', chapter: 'Verify email', screen: 'home', target: 'greeting', verb: 'look',
      title: { en: 'Welcome to Home', hi: 'होम पेज पर स्वागत है' },
      body: {
        en: 'Every new account lands here. “Latest activity” fills with bids, trips and updates; “Quick actions” is on the right.',
        hi: 'हर नया अकाउंट यहीं आता है। “Latest activity” में बोली, ट्रिप और अपडेट दिखेंगे; दाईं ओर “Quick actions” है।',
      },
    },
  ]
}

const shipper: Step[] = [
  {
    id: 'go-settings', chapter: 'PAN & GST', screen: 'home', target: 'nav-settings', verb: 'click',
    title: { en: 'Open Settings first', hi: 'पहले Settings खोलें' },
    body: { en: 'Posting a load needs a verified PAN and a GSTIN on file. Both live in Settings.', hi: 'लोड पोस्ट करने के लिए वेरिफ़ाइड PAN और GSTIN ज़रूरी है। दोनों Settings में मिलते हैं।' },
  },
  {
    id: 'scan-pan', chapter: 'PAN & GST', screen: 'settings', target: 'scan-pan', verb: 'upload', doc: 'pan',
    title: { en: 'Upload your PAN card', hi: 'अपना PAN कार्ड अपलोड करें' },
    body: { en: 'Click “Scan PAN card” and take a photo. The PAN, name and date of birth fill in by themselves — or type them.', hi: '“Scan PAN card” दबाएँ और फ़ोटो लें। PAN, नाम और जन्मतिथि अपने आप भर जाएँगे — या ख़ुद लिखें।' },
    fill: { pan: DEMO.shipper.pan, panName: DEMO.shipper.name, panDob: '12 Apr 1988' },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'verify-pan', chapter: 'PAN & GST', screen: 'settings', target: 'verify-pan', verb: 'click',
    title: { en: 'Click “Verify PAN”', hi: '“Verify PAN” दबाएँ' },
    body: { en: 'The PAN is checked against the PAN record. The number itself is not stored.', hi: 'PAN को सरकारी रिकॉर्ड से मिलाया जाता है। नंबर सेव नहीं होता।' },
    set: ['pan'], toast: 'PAN verified.',
  },
  {
    id: 'scan-gst', chapter: 'PAN & GST', screen: 'settings', target: 'scan-gst', verb: 'upload', doc: 'gst',
    title: { en: 'Upload your GST certificate', hi: 'GST सर्टिफ़िकेट अपलोड करें' },
    body: { en: 'Click “Scan GST certificate” (REG-06). The GSTIN fills in and is matched with your PAN.', hi: '“Scan GST certificate” (REG-06) दबाएँ। GSTIN भर जाएगा और आपके PAN से मिलाया जाएगा।' },
    fill: { gstin: DEMO.shipper.gstin },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'save-gstin', chapter: 'PAN & GST', screen: 'settings', target: 'save-gstin', verb: 'click',
    title: { en: 'Click “Save GSTIN”', hi: '“Save GSTIN” दबाएँ' },
    body: { en: 'Optional: “Verify it’s yours by OTP” sends an OTP to the GST-registered mobile.', hi: 'चाहें तो “Verify it’s yours by OTP” से GST में दर्ज मोबाइल पर OTP भेजकर पुष्टि करें।' },
    set: ['gst'], toast: 'GSTIN saved — you can post a load',
  },
  {
    id: 'address', chapter: 'PAN & GST', screen: 'settings', target: 'address', verb: 'type',
    title: { en: 'Add your billing address', hi: 'बिलिंग पता डालें' },
    body: { en: 'Printed on your invoices and e-way bills. Fill address, city, state and PIN code.', hi: 'यह आपके बिल और ई-वे बिल पर छपता है। पता, शहर, राज्य और पिन कोड भरें।' },
    type: ['address', '14, Peenya Industrial Area, Phase 2'],
    fill: { city: 'Bengaluru', state: 'Karnataka', pin: '560058' },
  },
  {
    id: 'save-address', chapter: 'PAN & GST', screen: 'settings', target: 'save-address', verb: 'click',
    title: { en: 'Click “Save address”', hi: '“Save address” दबाएँ' },
    body: { en: 'You are ready to post your first load.', hi: 'अब आप अपना पहला लोड पोस्ट कर सकते हैं।' },
    set: ['address'], toast: 'Address saved',
  },
  {
    id: 'go-post', chapter: 'First load', screen: 'settings', target: 'nav-post', verb: 'click',
    title: { en: 'Open “Post a Load”', hi: '“Post a Load” खोलें' },
    body: { en: 'In the side menu under SHIPPING.', hi: 'साइड मेन्यू में SHIPPING के नीचे।' },
  },
  {
    id: 'pickup', chapter: 'First load', screen: 'post', target: 'pickup', verb: 'type',
    title: { en: 'Type the pickup address', hi: 'पिकअप का पता लिखें' },
    body: { en: 'Start typing and pick from the list. You can drag the pin to the exact gate.', hi: 'लिखना शुरू करें और सूची से चुनें। पिन खींचकर सही गेट पर रखें।' },
    type: ['pickup', 'Peenya Industrial Area, Bengaluru'],
  },
  {
    id: 'drop', chapter: 'First load', screen: 'post', target: 'drop', verb: 'type',
    title: { en: 'Type the drop address', hi: 'ड्रॉप का पता लिखें' },
    body: { en: 'Where the load has to reach.', hi: 'जहाँ माल पहुँचाना है।' },
    type: ['drop', 'MIDC Butibori, Nagpur'],
  },
  {
    id: 'consignee', chapter: 'First load', screen: 'post', target: 'consignee', verb: 'type',
    title: { en: 'Who receives it?', hi: 'माल कौन लेगा?' },
    body: { en: 'Receiver name and 10-digit mobile. The delivery code is shared with them.', hi: 'माल लेने वाले का नाम और 10 अंकों का मोबाइल। डिलीवरी कोड उन्हें मिलेगा।' },
    type: ['consignee', 'Vidarbha Traders'], fill: { consigneePhone: '98230 45678' },
  },
  {
    id: 'weight', chapter: 'First load', screen: 'post', target: 'weight', verb: 'type',
    title: { en: 'Enter the weight', hi: 'वज़न डालें' },
    body: { en: 'The right truck size is picked from the weight. Choose the load type too.', hi: 'वज़न से सही ट्रक अपने आप चुना जाता है। लोड का प्रकार भी चुनें।' },
    type: ['weight', '12000'],
  },
  {
    id: 'date', chapter: 'First load', screen: 'post', target: 'pickup-date', verb: 'type',
    title: { en: 'Pick the pickup date', hi: 'पिकअप की तारीख़ चुनें' },
    body: { en: 'When the truck should collect the load.', hi: 'ट्रक माल कब उठाए।' },
    type: ['date', '06 Nov 2026'],
  },
  {
    id: 'auction', chapter: 'First load', screen: 'post', target: 'auction', verb: 'click',
    title: { en: 'Choose “Auction”', hi: '“Auction” चुनें' },
    body: { en: 'Open to all carriers — they bid, you pick the best one.', hi: 'सभी ट्रक वालों के लिए खुला — वे बोली लगाएँगे, आप सबसे अच्छी चुनें।' },
    set: ['auction'],
  },
  {
    id: 'quote', chapter: 'First load', screen: 'post', target: 'get-quote', verb: 'click',
    title: { en: 'Click “Get quote”', hi: '“Get quote” दबाएँ' },
    body: { en: 'You see an indicative rate built from the truck’s operating cost, the carrier’s margin and the tolls on your route.', hi: 'आपको अनुमानित किराया दिखेगा — ट्रक का ख़र्च, ट्रक वाले का मुनाफ़ा और रास्ते के टोल मिलाकर।' },
    set: ['quote'],
  },
  {
    id: 'post', chapter: 'First load', screen: 'post', target: 'post-load', verb: 'click',
    title: { en: 'Click “Post load”', hi: '“Post load” दबाएँ' },
    body: { en: 'Your load is live. Bids appear on Home and on the load’s page.', hi: 'आपका लोड लाइव है। बोलियाँ होम पर और लोड के पेज पर दिखेंगी।' },
    set: ['posted'], toast: 'Load posted',
  },
]

const driver: Step[] = [
  {
    id: 'go-profile', chapter: 'Driver profile', screen: 'home', target: 'nav-driver-profile', verb: 'click',
    title: { en: 'Open “Driver profile”', hi: '“Driver profile” खोलें' },
    body: { en: 'In the side menu under DRIVING.', hi: 'साइड मेन्यू में DRIVING के नीचे।' },
  },
  {
    id: 'register-driver', chapter: 'Driver profile', screen: 'driver-profile', target: 'register-driver', verb: 'click',
    title: { en: 'Click “Register as a driver”', hi: '“Register as a driver” दबाएँ' },
    body: { en: 'Just your driving licence and details. You do not need a truck.', hi: 'सिर्फ़ ड्राइविंग लाइसेंस और आपकी जानकारी। ट्रक ज़रूरी नहीं।' },
    set: ['driver'], toast: 'Driver profile created — add your details below',
  },
  {
    id: 'scan-aadhaar', chapter: 'Driver profile', screen: 'driver-profile', target: 'scan-aadhaar', verb: 'upload', doc: 'aadhaar',
    title: { en: 'Upload your Aadhaar card', hi: 'आधार कार्ड अपलोड करें' },
    body: { en: 'Click “Scan Aadhaar card”. Your name and home city fill in. The Aadhaar number is not kept.', hi: '“Scan Aadhaar card” दबाएँ। आपका नाम और शहर अपने आप भर जाएगा। आधार नंबर सेव नहीं होता।' },
    fill: { dName: DEMO.driver.name, dCity: DEMO.driver.city },
    set: ['aadhaarRead'], toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'languages', chapter: 'Driver profile', screen: 'driver-profile', target: 'languages', verb: 'type',
    title: { en: 'Add the languages you speak', hi: 'आप कौन-सी भाषाएँ बोलते हैं' },
    body: { en: 'Type a language and press Enter.', hi: 'भाषा लिखें और Enter दबाएँ।' },
    type: ['languages', 'Hindi, Marathi'],
  },
  {
    id: 'save-details', chapter: 'Driver profile', screen: 'driver-profile', target: 'save-details', verb: 'click',
    title: { en: 'Click “Save details”', hi: '“Save details” दबाएँ' },
    body: { en: 'This is what a fleet owner or shipper sees about you.', hi: 'यही जानकारी फ़्लीट मालिक या शिपर को दिखती है।' },
    set: ['details'], toast: 'Details saved',
  },
  {
    id: 'scan-licence', chapter: 'Licence & bank', screen: 'driver-profile', target: 'scan-licence', verb: 'upload', doc: 'licence',
    title: { en: 'Upload your driving licence', hi: 'ड्राइविंग लाइसेंस अपलोड करें' },
    body: { en: 'Click “Scan your licence” and photograph the front. Or use “Verify with DigiLocker” — verified on the spot.', hi: '“Scan your licence” दबाकर सामने की फ़ोटो लें। या “Verify with DigiLocker” से तुरंत वेरिफ़ाई करें।' },
    fill: { dl: DEMO.driver.dl, dlValid: '14 Aug 2031', dlClasses: 'LMV, HGMV, TRANS' },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'submit-licence', chapter: 'Licence & bank', screen: 'driver-profile', target: 'submit-licence', verb: 'click',
    title: { en: 'Click “Submit licence”', hi: '“Submit licence” दबाएँ' },
    body: { en: 'Our ops team checks it against the transport record.', hi: 'हमारी टीम इसे परिवहन रिकॉर्ड से जाँचती है।' },
    set: ['licence'], toast: 'Driving licence submitted',
  },
  {
    id: 'scan-cheque', chapter: 'Licence & bank', screen: 'driver-profile', target: 'scan-cheque', verb: 'upload', doc: 'cheque',
    title: { en: 'Upload a cancelled cheque or passbook', hi: 'कैंसल्ड चेक या पासबुक अपलोड करें' },
    body: { en: 'Click “Scan cheque or passbook”. Account number, IFSC and holder name fill in. Stored encrypted.', hi: '“Scan cheque or passbook” दबाएँ। खाता नंबर, IFSC और नाम भर जाएँगे। सुरक्षित (encrypted) रखा जाता है।' },
    fill: { acct: DEMO.driver.account, ifsc: DEMO.driver.ifsc, holder: DEMO.driver.name, bank: DEMO.driver.bank },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'link-account', chapter: 'Licence & bank', screen: 'driver-profile', target: 'link-account', verb: 'click',
    title: { en: 'Click “Link account”', hi: '“Link account” दबाएँ' },
    body: { en: 'Trip payouts are paid to this account.', hi: 'ट्रिप का पैसा इसी खाते में आएगा।' },
    set: ['bank'], toast: 'Account confirmed with the bank',
  },
  {
    id: 'checklist', chapter: 'Licence & bank', screen: 'driver-profile', target: 'checklist', verb: 'look',
    title: { en: 'Check your verification', hi: 'अपना वेरिफ़िकेशन देखें' },
    body: { en: 'Three of four done. “Driving licence verified” ticks once our team has checked it.', hi: 'चार में से तीन पूरे। टीम की जाँच के बाद “Driving licence verified” पर टिक लग जाएगा।' },
  },
  {
    id: 'invite', chapter: 'Join a fleet', screen: 'home', target: 'accept-invite', verb: 'click',
    title: { en: 'Accept a fleet’s invitation', hi: 'फ़्लीट का न्योता स्वीकार करें' },
    body: { en: 'When a fleet owner invites you, it shows on Home. Click “Accept” to drive for them.', hi: 'जब कोई फ़्लीट मालिक आपको बुलाए, तो होम पर दिखेगा। उनके लिए गाड़ी चलाने को “Accept” दबाएँ।' },
    set: ['joined'], toast: 'You joined Sharma Roadlines',
  },
]

const fleet: Step[] = [
  {
    id: 'setup-fleet', chapter: 'Fleet & GST', screen: 'home', target: 'setup-fleet', verb: 'click',
    title: { en: 'Click “Set up fleet management”', hi: '“Set up fleet management” दबाएँ' },
    body: { en: 'Creates your fleet profile so you can add trucks, invite drivers and bid on loads.', hi: 'आपकी फ़्लीट प्रोफ़ाइल बनती है — ट्रक जोड़ें, ड्राइवर बुलाएँ और लोड पर बोली लगाएँ।' },
    set: ['fleet'], toast: 'Fleet management is set up',
  },
  {
    id: 'gst-gate', chapter: 'Fleet & GST', screen: 'vehicles', target: 'gst-gate', verb: 'look',
    title: { en: 'GST comes first', hi: 'पहले GST' },
    body: { en: '“Add truck” stays locked until a GSTIN is saved. Let’s add it in Settings.', hi: 'GSTIN सेव होने तक “Add truck” बंद रहता है। चलिए Settings में जोड़ते हैं।' },
  },
  {
    id: 'go-settings', chapter: 'Fleet & GST', screen: 'vehicles', target: 'nav-settings', verb: 'click',
    title: { en: 'Open Settings', hi: 'Settings खोलें' },
    body: { en: 'At the bottom of the side menu.', hi: 'साइड मेन्यू में सबसे नीचे।' },
  },
  {
    id: 'scan-gst', chapter: 'Fleet & GST', screen: 'settings', target: 'scan-gst', verb: 'upload', doc: 'gst',
    title: { en: 'Upload your GST certificate', hi: 'GST सर्टिफ़िकेट अपलोड करें' },
    body: { en: 'Click “Scan GST certificate”. The GSTIN fills in.', hi: '“Scan GST certificate” दबाएँ। GSTIN भर जाएगा।' },
    fill: { gstin: DEMO.fleet.gstin },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'save-gstin', chapter: 'Fleet & GST', screen: 'settings', target: 'save-gstin', verb: 'click',
    title: { en: 'Click “Save GSTIN”', hi: '“Save GSTIN” दबाएँ' },
    body: { en: 'Trucks can now be added.', hi: 'अब ट्रक जोड़े जा सकते हैं।' },
    set: ['gst'], toast: 'GSTIN saved — you can post a load',
  },
  {
    id: 'scan-pan', chapter: 'Fleet & GST', screen: 'settings', target: 'scan-pan', verb: 'upload', doc: 'pan',
    title: { en: 'Upload your PAN card', hi: 'PAN कार्ड अपलोड करें' },
    body: { en: 'Needed before you can bid on loads. Click “Scan PAN card”.', hi: 'लोड पर बोली लगाने से पहले ज़रूरी। “Scan PAN card” दबाएँ।' },
    fill: { pan: DEMO.fleet.pan, panName: DEMO.fleet.company, panDob: '03 Jun 2011' },
    toast: 'Details filled in from your photo. Check them, then save.',
  },
  {
    id: 'verify-pan', chapter: 'Fleet & GST', screen: 'settings', target: 'verify-pan', verb: 'click',
    title: { en: 'Click “Verify PAN”', hi: '“Verify PAN” दबाएँ' },
    body: { en: 'Bidding is unlocked once the PAN is verified.', hi: 'PAN वेरिफ़ाई होते ही बोली लगाना चालू।' },
    set: ['pan'], toast: 'PAN verified.',
  },
  {
    id: 'company', chapter: 'Fleet & GST', screen: 'settings', target: 'company-name', verb: 'type',
    title: { en: 'Fill your company profile', hi: 'कंपनी की जानकारी भरें' },
    body: { en: 'Company name, contact phone and address — what shippers and invoices see.', hi: 'कंपनी का नाम, फ़ोन और पता — जो शिपर और बिल पर दिखता है।' },
    type: ['company', DEMO.fleet.company],
    fill: { cPhone: '+91 98220 11223', cAddress: 'Plot 14, Transport Nagar', cCity: 'Nagpur', cState: 'Maharashtra' },
  },
  {
    id: 'save-profile', chapter: 'Fleet & GST', screen: 'settings', target: 'save-profile', verb: 'click',
    title: { en: 'Click “Save profile”', hi: '“Save profile” दबाएँ' },
    body: { en: 'Now add your first truck.', hi: 'अब पहला ट्रक जोड़ें।' },
    set: ['company'], toast: 'Company profile saved',
  },
  {
    id: 'go-trucks', chapter: 'First truck', screen: 'settings', target: 'nav-trucks', verb: 'click',
    title: { en: 'Open “Trucks”', hi: '“Trucks” खोलें' },
    body: { en: 'In the side menu under ASSETS.', hi: 'साइड मेन्यू में ASSETS के नीचे।' },
  },
  {
    id: 'add-truck', chapter: 'First truck', screen: 'vehicles', target: 'add-truck', verb: 'click',
    title: { en: 'Click “Add truck”', hi: '“Add truck” दबाएँ' },
    body: { en: 'Have a lot of trucks? “Bulk upload” reads a CSV or a photo of your register.', hi: 'बहुत सारे ट्रक हैं? “Bulk upload” CSV या रजिस्टर की फ़ोटो पढ़ लेता है।' },
  },
  {
    id: 'rc', chapter: 'First truck', screen: 'vehicles', dialog: 'add-truck', target: 'rc-number', verb: 'type', doc: 'rc',
    title: { en: 'Type the RC number', hi: 'RC नंबर लिखें' },
    body: { en: 'Copy it from the truck’s RC, with the make and model.', hi: 'ट्रक की RC से नंबर, कंपनी और मॉडल लिखें।' },
    type: ['rc', DEMO.fleet.rc], fill: { make: 'Tata Signa 4825.TK' },
  },
  {
    id: 'cost-model', chapter: 'First truck', screen: 'vehicles', dialog: 'add-truck', target: 'cost-model', verb: 'type',
    title: { en: 'Pick category, emission norm and year', hi: 'कैटेगरी, एमिशन नॉर्म और साल चुनें' },
    body: { en: 'These decide the truck’s running cost in your estimates and dashboards.', hi: 'इन्हीं से ट्रक का चलाने का ख़र्च अनुमान और डैशबोर्ड में निकलता है।' },
    type: ['year', '2023'], fill: { category: 'HCV Cargo 42-48T', emission: 'BS6' },
  },
  {
    id: 'submit-truck', chapter: 'First truck', screen: 'vehicles', dialog: 'add-truck', target: 'submit-truck', verb: 'click',
    title: { en: 'Click “Add truck”', hi: '“Add truck” दबाएँ' },
    body: { en: 'The truck appears in your list.', hi: 'ट्रक आपकी सूची में आ जाएगा।' },
    set: ['truck'], toast: 'Truck added',
  },
  {
    id: 'go-drivers', chapter: 'First driver', screen: 'vehicles', target: 'nav-drivers', verb: 'click',
    title: { en: 'Open “Drivers”', hi: '“Drivers” खोलें' },
    body: { en: 'Invite the people who drive your trucks.', hi: 'जो लोग आपके ट्रक चलाते हैं, उन्हें बुलाएँ।' },
  },
  {
    id: 'invite', chapter: 'First driver', screen: 'drivers', target: 'invite-driver', verb: 'click',
    title: { en: 'Click “Invite driver”', hi: '“Invite driver” दबाएँ' },
    body: { en: 'The driver must already have a BharatTruck account.', hi: 'ड्राइवर का BharatTruck पर अकाउंट होना ज़रूरी है।' },
  },
  {
    id: 'driver-phone', chapter: 'First driver', screen: 'drivers', dialog: 'invite', target: 'invite-phone', verb: 'type',
    title: { en: 'Type the driver’s mobile number', hi: 'ड्राइवर का मोबाइल नंबर लिखें' },
    body: { en: 'Or switch to Email.', hi: 'या Email चुनें।' },
    type: ['invitePhone', DEMO.fleet.driverPhone],
  },
  {
    id: 'send-invite', chapter: 'First driver', screen: 'drivers', dialog: 'invite', target: 'send-invite', verb: 'click',
    title: { en: 'Click “Send invitation”', hi: '“Send invitation” दबाएँ' },
    body: { en: 'The driver sees it on their Home and accepts. Then assign them a truck and a trip.', hi: 'ड्राइवर को होम पर दिखेगा और वह स्वीकार करेगा। फिर उसे ट्रक और ट्रिप दें।' },
    set: ['invited'], toast: 'Invitation sent',
  },
]

const DONE: Record<Persona, Step> = Object.fromEntries((['shipper', 'driver', 'fleet'] as Persona[]).map((p) => [p, {
  id: 'done', chapter: 'Done', screen: 'done', target: 'done', verb: 'look',
  title: { en: 'You are all set', hi: 'सब तैयार है' },
  body: {
    en: p === 'shipper' ? 'Bids come in on Home. Compare them, accept one, and track the truck live to delivery.'
      : p === 'driver' ? 'Trips you are assigned show under “My Trips”, with navigation, the delivery code and photo proof.'
        : 'Bid on loads from “Find Work”, assign trucks and drivers to trips, and watch each truck’s earnings on the Dashboard.',
    hi: p === 'shipper' ? 'बोलियाँ होम पर आएँगी। तुलना करें, एक चुनें और डिलीवरी तक ट्रक को लाइव देखें।'
      : p === 'driver' ? 'आपको मिली ट्रिप “My Trips” में दिखेंगी — रास्ता, डिलीवरी कोड और फ़ोटो सबूत के साथ।'
        : '“Find Work” से लोड पर बोली लगाएँ, ट्रिप पर ट्रक और ड्राइवर लगाएँ, और डैशबोर्ड पर हर ट्रक की कमाई देखें।',
  },
}])) as Record<Persona, Step>

export function stepsFor(p: Persona): Step[] {
  return [...signUp(p), ...(p === 'shipper' ? shipper : p === 'driver' ? driver : fleet), DONE[p]]
}

/** The state after the first `n` steps are done — so any step can be opened directly. */
export function stateAfter(steps: Step[], n: number): DemoState {
  const s: DemoState = { f: {}, on: {} }
  for (const st of steps.slice(0, n)) {
    if (st.type) s.f[st.type[0]] = st.type[1]
    if (st.fill) Object.assign(s.f, st.fill)
    for (const k of st.set ?? []) s.on[k] = true
  }
  return s
}

export const VERB_LABEL: Record<Verb, L> = {
  click: { en: 'Click here', hi: 'यहाँ क्लिक करें' },
  type: { en: 'Type here', hi: 'यहाँ लिखें' },
  upload: { en: 'Upload here', hi: 'यहाँ अपलोड करें' },
  look: { en: 'Look here', hi: 'यहाँ देखें' },
}

export type Lang = 'en' | 'hi'

export type GuideStart = { p: Persona | null; s: number; lang: Lang; shot: boolean }

/** The starting point from the page's query string (?p=driver&s=7&lang=hi&shot=1), read on the server. */
export function startFrom(q: Record<string, string | string[] | undefined>): GuideStart {
  const one = (k: string) => { const v = q[k]; return Array.isArray(v) ? v[0] : v }
  const p = one('p')
  return {
    p: p === 'shipper' || p === 'driver' || p === 'fleet' ? p : null,
    s: Math.max(0, Number(one('s')) || 0),
    lang: one('lang') === 'hi' ? 'hi' : 'en',
    shot: one('shot') === '1',
  }
}
