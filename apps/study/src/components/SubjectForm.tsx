import { useId, useState } from 'react'
import { validateSubject } from '../lib/subjects'
import type { Subject, SubjectInput } from '../lib/subjects'

type Props = {
  subject?: Subject
  disabled: boolean
  busy: boolean
  onSave: (input: SubjectInput) => Promise<boolean>
  onCancel: () => void
}

export default function SubjectForm({ subject, disabled, busy, onSave, onCancel }: Props) {
  const id = useId()
  const [name, setName] = useState(subject?.name ?? '')
  const [code, setCode] = useState(subject?.code ?? '')
  const [error, setError] = useState<string | null>(null)
  return (
    <form className="subject-form" aria-busy={busy} onSubmit={async event => {
      event.preventDefault()
      setError(null)
      try { validateSubject({ name, code }) }
      catch (validationError) {
        setError(validationError instanceof Error ? validationError.message : 'Kontroller fagnavn og kode.')
        return
      }
      if (await onSave({ name, code })) onCancel()
    }}>
      <fieldset disabled={disabled}>
        <legend>{subject ? 'Rediger fag' : 'Nytt fag'}</legend>
        <div className="auth-field">
          <label htmlFor={`${id}-name`}>Fagnavn</label>
          <input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} required autoFocus
            aria-describedby={`${id}-help`} />
        </div>
        <div className="auth-field">
          <label htmlFor={`${id}-code`}>Fagkode (valgfri)</label>
          <input id={`${id}-code`} value={code} onChange={event => setCode(event.target.value)} />
        </div>
        <p id={`${id}-help`} className="subject-help">Maks 120 tegn i navn og 32 tegn i kode.</p>
      </fieldset>
      <div className="subject-actions">
        <button type="submit" disabled={disabled}>{busy ? 'Lagrer …' : subject ? 'Lagre endringer' : 'Opprett fag'}</button>
        <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Avbryt</button>
      </div>
      {error && <p role="alert" className="auth-error">{error}</p>}
    </form>
  )
}
