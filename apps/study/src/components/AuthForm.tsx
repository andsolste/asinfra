import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { authErrorMessage } from '../lib/auth-errors'

export default function AuthForm() {
  const [registering, setRegistering] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || pending) return
    setPending(true); setError(null); setNotice(null)
    try {
      const credentials = { email: email.trim(), password }
      const result = registering
        ? await supabase.auth.signUp({ ...credentials, options: {
          emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href,
        } })
        : await supabase.auth.signInWithPassword(credentials)
      if (result.error) setError(authErrorMessage(result.error.code, registering))
      else {
        setPassword('')
        if (registering && !result.data.session) {
          setNotice('Sjekk innboksen din. Hvis registreringen ble godkjent, må du bekrefte e-postadressen via lenken før du logger inn.')
        }
      }
    } catch { setError(authErrorMessage(undefined, registering)) }
    finally { setPending(false) }
  }

  return (
    <section className="auth-section" aria-labelledby="auth-title">
      <h2 id="auth-title">{registering ? 'Opprett konto' : 'Logg inn'}</h2>
      <p>Bruk e-post og passord. Nye kontoer må bekrefte e-postadressen når dette kreves av Supabase.</p>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending}>
          <div className="auth-field">
            <label htmlFor="email">E-post</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
          </div>
          <div className="auth-field">
            <label htmlFor="password">Passord</label>
            <input id="password" type="password" required minLength={registering ? 8 : undefined}
              autoComplete={registering ? 'new-password' : 'current-password'}
              aria-describedby={registering ? 'password-help' : undefined}
              value={password} onChange={event => setPassword(event.target.value)} />
            {registering && <small id="password-help">Minst 8 tegn.</small>}
          </div>
          <button type="submit">{pending ? 'Venter …' : registering ? 'Opprett konto' : 'Logg inn'}</button>
        </fieldset>
      </form>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="button" className="text-button" disabled={pending} onClick={() => {
        setRegistering(!registering); setPassword(''); setError(null); setNotice(null)
      }}>{registering ? 'Har du konto? Logg inn' : 'Ny her? Opprett konto'}</button>
    </section>
  )
}
