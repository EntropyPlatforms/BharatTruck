// Sample documents for the onboarding guide. Deliberately generic drawings: demo names and
// numbers, no emblems, seals, QR codes or photos of anyone, and a SPECIMEN watermark across
// each — they show WHICH document goes WHERE, and can never pass for a real one.

import type { DocKind, Persona } from './steps'
import { DEMO } from './steps'

const W = 340, H = 214

function Frame({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto drop-shadow-md" role="img" aria-label={`${title} — sample, not a real document`}>
      <rect x="1" y="1" width={W - 2} height={H - 2} rx="14" fill="#fff" stroke="#cbd2dc" />
      <rect x="1" y="1" width={W - 2} height="38" rx="14" fill={tone} />
      <rect x="1" y="26" width={W - 2} height="13" fill={tone} />
      <text x="16" y="25" fontSize="13" fontWeight="800" fill="#fff" fontFamily="Manrope, sans-serif">{title}</text>
      <text x={W - 16} y="25" fontSize="10" fontWeight="700" fill="#fff" textAnchor="end" fontFamily="Manrope, sans-serif">SAMPLE</text>
      <g fontFamily="Manrope, sans-serif" fill="#14181f">{children}</g>
      <text x={W / 2} y={H / 2 + 30} fontSize="34" fontWeight="800" fill="#c8322b" opacity="0.16" textAnchor="middle"
        transform={`rotate(-18 ${W / 2} ${H / 2 + 20})`} fontFamily="Manrope, sans-serif">SPECIMEN · DEMO</text>
    </svg>
  )
}

const Row = ({ y, k, v, mono }: { y: number; k: string; v: string; mono?: boolean }) => (
  <>
    <text x="16" y={y} fontSize="9" fill="#5b6676">{k}</text>
    <text x="16" y={y + 14} fontSize="12.5" fontWeight="700" fontFamily={mono ? 'IBM Plex Mono, monospace' : undefined}>{v}</text>
  </>
)

/** A plain silhouette in place of a photo — never a face. */
const Silhouette = ({ x, y }: { x: number; y: number }) => (
  <g>
    <rect x={x} y={y} width="70" height="84" rx="8" fill="#eef1f5" stroke="#e3e7ee" />
    <circle cx={x + 35} cy={y + 32} r="15" fill="#cbd2dc" />
    <path d={`M${x + 12} ${y + 78}q23-30 46 0`} fill="#cbd2dc" />
  </g>
)

export function SampleDoc({ kind, persona }: { kind: DocKind; persona: Persona }) {
  const biz = persona === 'fleet' ? DEMO.fleet : DEMO.shipper
  switch (kind) {
    case 'aadhaar':
      return (
        <Frame title="Aadhaar card (sample)" tone="#c2410c">
          <Silhouette x={16} y={52} />
          <g transform="translate(96 0)">
            <Row y={62} k="Name" v={DEMO.driver.name} />
            <Row y={96} k="Date of birth" v="09/03/1990" />
            <Row y={130} k="Address" v="Ward 12, Hingna Road, Nagpur" />
          </g>
          <text x={W / 2} y="196" fontSize="17" fontWeight="800" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" letterSpacing="2">
            XXXX XXXX {DEMO.driver.aadhaarLast4}
          </text>
        </Frame>
      )
    case 'pan':
      return (
        <Frame title="PAN card (sample)" tone="#1d47d1">
          <Row y={62} k="Name" v={(persona === 'fleet' ? DEMO.fleet.company : DEMO.shipper.name).toUpperCase()} />
          <Row y={96} k="Date of birth / incorporation" v={persona === 'fleet' ? '03/06/2011' : '12/04/1988'} />
          <Row y={130} k="Permanent Account Number" v={biz.pan} mono />
          <text x="16" y="194" fontSize="9" fill="#5b6676">Demo values for the BharatTruck onboarding guide</text>
        </Frame>
      )
    case 'licence':
      return (
        <Frame title="Driving licence (sample)" tone="#0f766e">
          <Silhouette x={W - 86} y={52} />
          <Row y={62} k="Licence number" v={DEMO.driver.dl} mono />
          <Row y={96} k="Name" v={DEMO.driver.name} />
          <Row y={130} k="Valid till (non-transport)" v="14/08/2031" />
          <Row y={164} k="Classes" v="LMV · HGMV · TRANS" />
        </Frame>
      )
    case 'cheque':
      return (
        <Frame title="Cancelled cheque (sample)" tone="#475263">
          <text x="16" y="62" fontSize="12.5" fontWeight="800">{DEMO.driver.bank} — Demo branch</text>
          <text x="16" y="78" fontSize="10" fill="#5b6676">IFSC</text>
          <text x="46" y="78" fontSize="11" fontWeight="700" fontFamily="IBM Plex Mono, monospace">{DEMO.driver.ifsc}</text>
          <line x1="16" y1="104" x2={W - 16} y2="104" stroke="#cbd2dc" />
          <text x="16" y="122" fontSize="10" fill="#5b6676">A/c holder</text>
          <text x="80" y="122" fontSize="12" fontWeight="700">{DEMO.driver.name}</text>
          <text x="16" y="144" fontSize="10" fill="#5b6676">A/c no.</text>
          <text x="80" y="144" fontSize="12" fontWeight="700" fontFamily="IBM Plex Mono, monospace">{DEMO.driver.account}</text>
          <text x={W / 2} y="186" fontSize="22" fontWeight="800" fill="#c8322b" textAnchor="middle" transform={`rotate(-6 ${W / 2} 180)`}>CANCELLED</text>
        </Frame>
      )
    case 'gst':
      return (
        <Frame title="GST registration — REG-06 (sample)" tone="#15803d">
          <Row y={62} k="GSTIN" v={biz.gstin} mono />
          <Row y={96} k="Legal name" v={biz.company} />
          <Row y={130} k="Constitution" v={persona === 'fleet' ? 'Partnership' : 'Proprietorship'} />
          <Row y={164} k="Status" v="Active (demo)" />
        </Frame>
      )
    case 'rc':
      return (
        <Frame title="Registration certificate — RC (sample)" tone="#6d28d9">
          <Row y={62} k="Registration no." v={DEMO.fleet.rc} mono />
          <Row y={96} k="Owner" v={DEMO.fleet.company} />
          <Row y={130} k="Maker / model" v="Tata Signa 4825.TK · 2023" />
          <Row y={164} k="Fuel / norm" v="Diesel · BS6" />
        </Frame>
      )
  }
}

export const DOC_LABEL: Record<DocKind, string> = {
  aadhaar: 'Aadhaar card', pan: 'PAN card', licence: 'Driving licence', cheque: 'Cancelled cheque', gst: 'GST certificate', rc: 'RC (registration certificate)',
}
