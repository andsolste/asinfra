import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let active = true
    let receivedEvent = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return
      receivedEvent = true
      setSession(next)
      setLoading(false)
      setError(null)
    })
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active || receivedEvent) return
      setSession(data.session)
      setError(sessionError ? 'Kunne ikke gjenopprette innloggingen. Last siden på nytt og prøv igjen.' : null)
      setLoading(false)
    }).catch(() => {
      if (!active || receivedEvent) return
      setError('Kunne ikke gjenopprette innloggingen. Last siden på nytt og prøv igjen.')
      setLoading(false)
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  return { session, loading, error }
}
