# Onboarding guide PDF

`bt-app/public/onboarding/BharatTruck-Onboarding-Guide.pdf` is built from the interactive guide
(`bt-app/src/app/guide`, live at www.bharattruck.net/guide). Rebuild it whenever a guided screen changes:

1. Run the app: `cd bt-app && npx next dev -p 3123`
2. Here: `npm install`, then `npm run capture` — walks every step of every role in screenshot
   mode (`/guide?p=…&s=…&shot=1`), fails if any step's target is missing, writes `shots/` and `steps.json`.
3. `npm run pdf` — one common PDF: shared sign-up, then Shipper, Driver and Fleet owner.

It drives the Microsoft Edge that ships with Windows (`puppeteer-core`, no browser download). On
another machine, change `EDGE` in both scripts to a local Chrome or Edge path.
