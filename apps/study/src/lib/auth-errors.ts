export function authErrorMessage(code: string | undefined, registering = false) {
  switch (code) {
    case 'invalid_credentials': return 'E-post eller passord er feil.'
    case 'email_not_confirmed': return 'Bekreft e-postadressen din før du logger inn.'
    case 'weak_password': return 'Velg et sterkere passord. Bruk minst 8 tegn.'
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit': return 'For mange forsøk. Vent litt og prøv igjen.'
    default: return registering
      ? 'Registreringen kunne ikke fullføres. Kontroller feltene og prøv igjen.'
      : 'Kunne ikke logge inn. Kontroller feltene eller prøv igjen senere.'
  }
}
