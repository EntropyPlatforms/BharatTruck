# Task: `feat/bt-app-ui-cleanup`

**Founder feedback (2026-08-08):** not a fan of the explanatory prose in the UI — keep it clean.
Drop the explanations; at most a small **ⓘ** with a one-phrase hint, and only for a term people
might not fully know (e.g. *Variance*). See [[bt-app-primary-persona-driven-ui]] session.

## What changed (pure copy/layout — no behaviour change)

- **`bt-app/src/components/stat.tsx`** — `Stat` gains an optional `info` prop → a small ⓘ next to
  the label with a one-phrase hover hint. This is the only place explanatory text now belongs.
- **`bt-app/src/app/(app)/fuel/page.tsx`** — condensed the "no fuel entries" card from 3 paragraphs
  to one line; removed the whole **"How the estimate is built"** card, the "gap that persists /
  spending under the model" caveat paragraph, and the verbose table hint + legend trailers. Variance
  now carries an ⓘ ("Actual − modelled diesel spend").
- **`bt-app/src/app/(app)/settings/page.tsx`** — removed the **"How your costs are modelled"** card
  and the 3-paragraph monthly-overhead explanation box.
- **`bt-app/src/components/completeness-section.tsx`** — dropped the per-item explanatory notes and
  shortened the card sub.

Left intact: compact functional disclosures that aren't prose (e.g. the post page's advisory-pricing
line, which is a D-11 legal disclosure, not an explanation) and functional instructions inside action
flows (e.g. "enter the code the receiver reads out").

## Verification

- `bt-app npm run build` → clean (tsc + next build). No behaviour change to verify against the API.

## Follow-up

More explanatory prose may remain on other surfaces; this is the first pass over the clear offenders
(the fuel screenshot the founder flagged + the settings cost/overhead prose). Sweep more if flagged.
