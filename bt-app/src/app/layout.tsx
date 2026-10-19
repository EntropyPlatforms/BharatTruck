import type { Metadata, Viewport } from 'next'
import { Manrope, IBM_Plex_Mono } from 'next/font/google'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/lib/auth'
import { THEME_BOOT_SCRIPT } from '@/lib/theme'
import { ThemeSync } from '@/components/theme-sync'
import './globals.css'

const manrope = Manrope({ variable: '--font-manrope', subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] })
const plexMono = IBM_Plex_Mono({ variable: '--font-plex-mono', subsets: ['latin'], weight: ['400', '500', '600'] })

export const metadata: Metadata = {
  title: 'BharatTruck',
  description: 'One BharatTruck login — post loads, find work, drive, and run your fleet.',
}

export const viewport: Viewport = {
  themeColor: '#f2a516',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script may add `dark` to <html> before React hydrates.
    <html lang="en" suppressHydrationWarning className={`${manrope.variable} ${plexMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="h-full bg-gray-50 text-gray-900">
        <ThemeSync />
        <AuthProvider>{children}</AuthProvider>
        <Toaster position="top-right" richColors toastOptions={{ style: { fontFamily: 'var(--font-manrope)' } }} />
      </body>
    </html>
  )
}
