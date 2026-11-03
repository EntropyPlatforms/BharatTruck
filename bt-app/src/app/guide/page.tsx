import type { Metadata } from 'next'

import GuideApp from '@/components/guide/guide-app'
import { startFrom } from '@/components/guide/steps'
import './guide.css'

// Public onboarding guide (www.bharattruck.net/guide): no sign-in, no API calls, demo data only.
export const metadata: Metadata = {
  title: 'Onboarding guide · BharatTruck',
  description: 'See how to sign up on BharatTruck as a shipper, driver or fleet owner — step by step, with arrows on every screen.',
}

export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <GuideApp start={startFrom(await searchParams)} />
}
