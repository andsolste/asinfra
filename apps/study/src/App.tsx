import Account from './components/Account'
import AuthForm from './components/AuthForm'
import { useAuth } from './hooks/useAuth'
import { supabase } from './lib/supabase'

export default function App() {
  const { session, loading, error } = useAuth()
  return (
    <main className="study-shell">
      <header className="study-header">
        <p className="study-label">Study-appen</p>
        <h1>Study</h1>
        <p className="study-description">
          Study Dashboard er under utvikling.
        </p>
      </header>
      {!supabase ? <p className="auth-section" role="alert">Study mangler gyldig Supabase-konfigurasjon. Kontroller prosjekt-URL og publishable key før appen bygges.</p>
        : loading ? <p className="auth-section" role="status">Henter innlogging …</p>
          : session ? <Account key={session.user.id} session={session} />
            : <>{error && <p role="alert" className="auth-error">{error}</p>}<AuthForm /></>}
    </main>
  )
}
