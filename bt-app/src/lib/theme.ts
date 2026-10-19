/**
 * Light / dark theme (2026-10). The theme is applied as a `dark` class on <html>;
 * globals.css re-points the colour tokens under it.
 *
 * Three choices, saved in localStorage on this device:
 *  - 'auto' (the default): dark at night and light by day, by INDIAN time (IST) wherever
 *    the viewer is — night is 7 pm to 6 am.
 *  - 'light' / 'dark': fixed.
 * The public pages (home, sign-in and the other /auth screens) are ALWAYS automatic; the
 * saved choice applies only inside the app.
 *
 * An inline copy of this logic (THEME_BOOT_SCRIPT) runs in app/layout.tsx before first
 * paint so the page never flashes the wrong theme, and <ThemeSync> re-applies it on
 * navigation and as the clock passes 6 am / 7 pm. Keep the three in step.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark'

export const THEME_KEY = 'bt_theme'

/** Night in IST: from 19:00 up to (not including) 06:00. */
const NIGHT_FROM = 19
const NIGHT_TO = 6

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

/** The hour of the day in India (0–23), independent of the device's time zone. */
export function istHour(now: Date = new Date()): number {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 330
  return Math.floor(minutes / 60) % 24
}

export function isNightInIndia(now: Date = new Date()): boolean {
  const h = istHour(now)
  return h >= NIGHT_FROM || h < NIGHT_TO
}

/** Home, sign-in and the /auth screens: always automatic. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/login' || pathname.startsWith('/auth')
}

export function applyTheme(choice: ThemeChoice, pathname: string = window.location.pathname): void {
  const effective = isPublicPath(pathname) ? 'auto' : choice
  const dark = effective === 'dark' || (effective === 'auto' && isNightInIndia())
  document.documentElement.classList.toggle('dark', dark)
}

export function saveTheme(choice: ThemeChoice): void {
  try { localStorage.setItem(THEME_KEY, choice) } catch { /* storage unavailable: applies for this visit only */ }
  applyTheme(choice)
}

/** Runs before hydration (see app/layout.tsx). Plain ES5, no imports. */
export const THEME_BOOT_SCRIPT =
  "(function(){try{var p=location.pathname,c=null;" +
  "try{c=localStorage.getItem('" + THEME_KEY + "')}catch(e){}" +
  "if(p==='/'||p==='/login'||p.indexOf('/auth')===0||(c!=='dark'&&c!=='light'))c='auto';" +
  "var n=new Date(),h=Math.floor((n.getUTCHours()*60+n.getUTCMinutes()+330)/60)%24;" +
  "if(c==='dark'||(c==='auto'&&(h>=" + NIGHT_FROM + "||h<" + NIGHT_TO + ")))document.documentElement.classList.add('dark')" +
  "}catch(e){}})()"
