import { createClient } from '@supabase/supabase-js'
import { readSupabaseConfig } from './config'

const config = readSupabaseConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
)

// Only a public browser key is accepted. Database access is enforced by RLS.
export const supabase = config ? createClient(config.url, config.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null
