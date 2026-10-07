import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type DataStatus = { state: 'loading' } | { state: 'ready'; count: number } | { state: 'error' }

export default function Account({ session }: { session: Session }) {
  const [data, setData] = useState<DataStatus>({ state: 'loading' })
  const [retry, setRetry] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let active = true
    const controller = new AbortController()
    setData({ state: 'loading' })
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    // The SDK supplies the session JWT. The filter does not replace database RLS.
    Promise.resolve(supabase.from('subjects').select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id).abortSignal(controller.signal))
      .then(({ error: queryError, count }) => {
        if (active) setData(queryError || count === null ? { state: 'error' } : { state: 'ready', count })
      }, () => { if (active) setData({ state: 'error' }) })
      .finally(() => window.clearTimeout(timeout))
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [session.user.id, session.access_token, retry])

  async function signOut() {
    if (!supabase) return
    setSigningOut(true); setError(null)
    try {
      const result = await supabase.auth.signOut({ scope: 'local' })
      if (result.error) setError('Kunne ikke logge ut. Prøv igjen.')
    } catch { setError('Kunne ikke logge ut. Prøv igjen.') }
    finally { setSigningOut(false) }
  }

  return (
    <section className="auth-section" aria-labelledby="account-title">
      <h2 id="account-title">Konto</h2>
      <p className="account-email">Innlogget som <strong>{session.user.email}</strong></p>
      <div role="status">
        {data.state === 'loading' && <p>Kontrollerer tilgangen til dine fag …</p>}
        {data.state === 'ready' && <p>Databasetilkoblingen fungerer. Du har {data.count} registrerte fag.</p>}
        {data.state === 'error' && <>
          <p>Kunne ikke hente fag. Databasen må være klargjort og kontoen må ha tilgang.</p>
          <button className="text-button" type="button" onClick={() => setRetry(retry + 1)}>Prøv igjen</button>
        </>}
      </div>
      <p>Fag og studieøkter bygges ut senere.</p>
      <button type="button" disabled={signingOut} onClick={signOut}>{signingOut ? 'Logger ut …' : 'Logg ut'}</button>
      {error && <p role="alert" className="auth-error">{error}</p>}
    </section>
  )
}
