import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readSupabaseConfig } from './src/lib/config.ts'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (command === 'build' && !readSupabaseConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('Study build requires a valid VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (public browser key).')
  }
  return { base: '/study/', plugins: [react()] }
})
