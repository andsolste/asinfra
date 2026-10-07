import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import Subjects from './Subjects'

export default function Account({ session }: { session: Session }) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <>
      <section className="auth-section" aria-labelledby="account-title">
        <h2 id="account-title">Konto</h2>
        <p className="account-email">Innlogget som <strong>{session.user.email}</strong></p>
        <button type="button" disabled={signingOut} onClick={signOut}>{signingOut ? 'Logger ut …' : 'Logg ut'}</button>
        {error && <p role="alert" className="auth-error">{error}</p>}
      </section>
      <Subjects />
    </>
  )
}
