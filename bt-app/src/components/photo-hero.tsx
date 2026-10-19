'use client'

/**
 * PhotoHero — the top of every page: the brand's sunset-highway photograph runs edge to
 * edge behind the page title (or a greeting), a line of copy, and whatever the page puts
 * beside or under them (actions, a period switch, quick-action buttons).
 *
 * The photo is positioned against the shell's <main> (which is `relative isolate`), not
 * against the page container, so it ignores the page's padding and width cap and scrolls
 * away with the content. It is decorative: a light wash on the left keeps the copy
 * readable, and its lower edge fades into the page so the first row of cards can overlap it.
 *
 * `size="lg"` is the tall greeting banner of Home and Dashboard; `"md"` (PageHeader) is
 * the shorter banner every other page gets.
 */

import Image from 'next/image'
import type { ReactNode } from 'react'
import { useAuth } from '@/lib/auth'
import { cx } from '@/lib/ui'

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function PhotoHero({ title, caption, subtitle, aside, children, size = 'lg' }: {
  /** Page title; omit for the time-of-day greeting with the viewer's first name. */
  title?: ReactNode
  /** Sits beside the title (PageHeader's one-phrase info caption). */
  caption?: ReactNode
  /** One line under the title. */
  subtitle?: ReactNode
  /** Top-right slot (page actions, the dashboard's period switch). */
  aside?: ReactNode
  /** Under the copy (e.g. quick-action buttons). */
  children?: ReactNode
  size?: 'lg' | 'md'
}) {
  const { user } = useAuth()
  const first = user?.full_name?.trim().split(/\s+/)[0]
  const lg = size === 'lg'
  return (
    <div className={cx('pt-2 sm:pt-5', lg ? 'pb-8 lg:min-h-[21rem] lg:pb-10' : 'pb-6 lg:min-h-[11.5rem] lg:pb-8')}>
      <div className={cx('pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden', lg ? 'h-[27rem]' : 'h-[17rem]')} aria-hidden>
        <Image src="/images/highway-milestone.webp" alt="" fill priority sizes="100vw" className={cx('object-cover dark:hidden', lg ? 'object-[50%_78%]' : 'object-[50%_70%]')} />
        <Image src="/images/highway-india-map-night.webp" alt="" fill loading="lazy" sizes="100vw" className={cx('object-cover hidden dark:block', lg ? 'object-[50%_92%]' : 'object-[50%_84%]')} />
        <div className="absolute inset-0 hero-wash-x" />
        {/* Phones: the copy spans the full width, so the whole photo is washed. */}
        <div className="absolute inset-0 bg-[var(--warm)]/65 sm:hidden" />
        <div className={cx('absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-50 via-gray-50/70 to-transparent', lg ? 'h-24' : 'h-20')} />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <h1 className={cx('font-extrabold tracking-[-0.025em] text-gray-900', lg ? 'text-[2rem] sm:text-[2.75rem] leading-[1.08]' : 'text-[1.75rem] sm:text-[2.25rem] leading-tight')}>
              {title ?? <>{greeting()}{first ? <>, <span className="text-brand-500">{first}</span></> : null}</>}
            </h1>
            {caption}
          </div>
          {subtitle && <p className={cx('mt-1.5 font-medium text-gray-800 max-w-2xl', lg ? 'text-base sm:text-lg' : 'text-[0.9375rem] sm:text-base')}>{subtitle}</p>}
        </div>
        {aside && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{aside}</div>}
      </div>
      {children && <div className="mt-6 flex flex-wrap gap-3">{children}</div>}
    </div>
  )
}
