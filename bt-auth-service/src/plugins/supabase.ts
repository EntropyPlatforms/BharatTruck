import fp from 'fastify-plugin'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance { supabase: SupabaseClient }
}

export const supabasePlugin = fp(async (app: FastifyInstance) => {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  app.decorate('supabase', createClient(url, key, { auth: { persistSession: false } }))
  app.log.info('Supabase connected')
})
