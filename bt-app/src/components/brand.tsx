/**
 * The BharatTruck mark and wordmark.
 *
 * The mark is the brand's front-on truck cab (rounded cab, side mirrors, windscreen,
 * angled headlights, bumper notch, two wheels), traced to vector from the supplied logo
 * artwork so it stays crisp from a 16px favicon to a 40px sign-in header. Cut-outs are
 * real holes (even-odd fill), so the mark works on any background.
 * The wordmark sets "Bharat" in ink and "Truck" in the mark's marigold.
 */

export const MARK_COLOR = '#fbb314'

export const MARK_VIEWBOX = '168 198 274 276'

/** The cab outline with windscreen and headlight holes. Exported for the favicon and the
 *  Build Log page, which draw the same shape outside React. */
export const MARK_BODY_PATH =
  'M243 202H368Q393 202 393 227V318Q393 324 399 327L430 340Q438 344 438 352V410Q438 420 428 420H362L349 405H261L248 420H182Q172 420 172 410V352Q172 344 180 340L211 327Q218 324 218 318V227Q218 202 243 202Z' +
  'M236 258H375Q381 258 381 264V306Q381 312 375 312H236Q230 312 230 306V264Q230 258 236 258Z' +
  'M211 352L244 364Q250 366 250 372V385Q250 391 244 389L210 377Q205 375 205 370V357Q205 350 211 352Z' +
  'M399 352L366 364Q360 366 360 372V385Q360 391 366 389L400 377Q405 375 405 370V357Q405 350 399 352Z'

export function BrandMark({ className = 'w-8 h-8', color = MARK_COLOR }: { className?: string; color?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} aria-hidden>
      <path fill={color} fillRule="evenodd" d={MARK_BODY_PATH} />
      <rect x="176" y="268" width="30" height="48" rx="8" fill={color} />
      <rect x="405" y="268" width="30" height="48" rx="8" fill={color} />
      <rect x="178" y="432" width="50" height="38" rx="8" fill={color} />
      <rect x="384" y="432" width="50" height="38" rx="8" fill={color} />
    </svg>
  )
}

export function Wordmark({ className = 'text-xl' }: { className?: string }) {
  return (
    <span className={`font-extrabold tracking-tight leading-none ${className}`}>
      <span className="text-gray-900">Bharat</span>
      <span style={{ color: MARK_COLOR }}>Truck</span>
    </span>
  )
}

export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const mark = size === 'lg' ? 'w-10 h-10' : size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'
  const text = size === 'lg' ? 'text-[1.75rem]' : size === 'sm' ? 'text-base' : 'text-xl'
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className={mark} />
      <Wordmark className={text} />
    </span>
  )
}
