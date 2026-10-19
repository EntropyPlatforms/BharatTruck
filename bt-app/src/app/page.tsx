'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { Landing } from '@/components/auth/landing'

/**
 * `/` — signed-in visitors go straight to the unified Home feed (unchanged); visitors
 * with no token see the public landing page, whose CTAs lead to /login.
 */
export default function IndexPage() {
  const router = useRouter()
  const { token, isReady } = useAuth()

  useEffect(() => {
    if (!isReady || !token) return
    // The front door is the unified Home feed, not any one persona's dashboard.
    router.replace('/home')
  }, [isReady, token, router])

  if (!isReady || token) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  return <Landing />
}
