import { useEffect, useRef, useState } from 'react'
import type { useSubjects } from '../hooks/useSubjects'
import { splitSubjects } from '../lib/subjects'
import type { Subject } from '../lib/subjects'
import SubjectForm from './SubjectForm'

export default function Subjects({ data }: { data: ReturnType<typeof useSubjects> }) {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const { active, archived } = splitSubjects(data.subjects)
  const disabled = data.busy || data.status !== 'ready'

  useEffect(() => {
    if (data.status === 'ready' && editing && !data.subjects.some(subject => subject.id === editing)) {
      setEditing(null)
      heading.current?.focus()
    }
  }, [data.status, data.subjects, editing])

  function closeForm() {
    setCreating(false); setEditing(null)
    heading.current?.focus()
  }

  function list(rows: Subject[]) {
    return <ul className="subject-list">{rows.map(subject => <li key={subject.id}>
      <div className="subject-heading">
        {subject.code && <p className="subject-code">{subject.code}</p>}
        <h4>{subject.name}</h4>
      </div>
      {editing === subject.id ? <SubjectForm subject={subject} disabled={disabled} busy={data.busy}
        onSave={input => data.save(input, subject.id)} onCancel={closeForm} />
        : <div className="subject-actions">
          <button type="button" className="text-button" disabled={disabled || creating || editing !== null}
            aria-label={`Rediger ${subject.name}`} onClick={() => setEditing(subject.id)}>Rediger</button>
          <button type="button" className="text-button" disabled={disabled || creating || editing !== null}
            aria-label={`${subject.is_archived ? 'Aktiver' : 'Arkiver'} ${subject.name}`}
            onClick={async () => { if (await data.setArchived(subject)) heading.current?.focus() }}>
            {subject.is_archived ? 'Aktiver igjen' : 'Arkiver'}</button>
        </div>}
    </li>)}</ul>
  }

  return <section className="subjects-section" aria-labelledby="subjects-title" aria-busy={data.busy}>
    <header className="subjects-heading">
      <h2 id="subjects-title" ref={heading} tabIndex={-1}>Dine fag</h2>
      {!creating && <button type="button" disabled={disabled || editing !== null} onClick={() => setCreating(true)}>Nytt fag</button>}
    </header>
    <p>Opprett egne fag eller kategorier. Arkiver fag du ikke bruker nå; de kan aktiveres igjen senere.</p>
    <p role="status">{data.status === 'loading' ? 'Henter fagene dine …' : data.busy ? 'Lagrer …' : data.notice}</p>
    {data.error && <div role="alert"><p className="auth-error">{data.error}</p>
      <button className="text-button" type="button" disabled={data.busy} onClick={() => void data.reload()}>Hent fag på nytt</button></div>}
    {creating && <SubjectForm disabled={disabled} busy={data.busy} onSave={input => data.save(input)} onCancel={closeForm} />}
    {data.status !== 'loading' && <>
      <section aria-labelledby="active-subjects-title">
        <h3 id="active-subjects-title">Aktive fag</h3>
        {active.length ? list(active) : data.status === 'ready' && <p>Du har ingen aktive fag. Opprett ditt første fag med «Nytt fag».</p>}
      </section>
      <details className="archived-subjects">
        <summary><h3>Arkiverte fag ({archived.length})</h3></summary>
        {archived.length ? list(archived) : data.status === 'ready' && <p>Du har ingen arkiverte fag.</p>}
      </details>
    </>}
  </section>
}
