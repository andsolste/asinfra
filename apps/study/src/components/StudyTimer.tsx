import { useEffect, useRef, useState } from 'react'
import type { useSubjects } from '../hooks/useSubjects'
import { useStudySession } from '../hooks/useStudySession'
import { formatDuration, sessionDurations, sessionStatus, validateSessionInput } from '../lib/study-sessions'
import type { SessionCommand } from '../lib/study-sessions'
import { splitSubjects } from '../lib/subjects'

export default function StudyTimer({ subjects }: { subjects: ReturnType<typeof useSubjects> }) {
  const data = useStudySession()
  const [subjectId, setSubjectId] = useState('')
  const [description, setDescription] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const heading = useRef<HTMLHeadingElement | null>(null)
  const { active } = splitSubjects(subjects.subjects)
  const current = data.current
  const status = current ? sessionStatus(current) : null
  const disabled = data.busy || !data.loaded || Boolean(data.pending) || Boolean(data.error)

  useEffect(() => {
    setNow(Date.now())
    if (status !== 'running') return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [status, current])

  async function transition(command: SessionCommand) {
    await data.dispatch(command)
    heading.current?.focus()
  }
  async function recover(action: 'retry' | 'reload') {
    await (action === 'retry' ? data.retry() : data.reload())
    heading.current?.focus()
  }
  async function start(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation(null)
    try {
      const text = validateSessionInput(subjectId, description, subjects.subjects)
      await transition({ action: 'start', sessionId: crypto.randomUUID(),
        segmentId: crypto.randomUUID(), subjectId, description: text })
    } catch (error) { setValidation(error instanceof Error ? error.message : 'Kontroller feltene.') }
  }
  const durations = current ? sessionDurations(current, now + data.clockOffset) : null
  const saved = data.saved ? sessionDurations(data.saved) : null
  const open = current?.segments.find(segment => segment.ended_at === null)
  const localTime = (time: string) => new Date(time).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

  return <section className="timer-section" aria-labelledby="timer-title" aria-busy={data.busy}>
    <h2 id="timer-title" ref={heading} tabIndex={-1}>{current ? 'Studieøkt' : 'Ny studieøkt'}</h2>
    <p role="status">{!data.loaded && !data.error ? 'Henter eventuell aktiv økt …'
      : data.busy ? 'Kontrollerer og lagrer …' : current ? status === 'running' ? 'Pågår' : 'Pauset' : ''}</p>
    {data.error && <div role="alert">
      <p className="auth-error">{data.error} Statusen kan ha blitt lagret selv om svaret ikke kom frem.</p>
      <div className="subject-actions">
        <button type="button" disabled={data.busy} onClick={() => void recover('retry')}>Prøv igjen</button>
        {data.pending && <button className="text-button" type="button" disabled={data.busy}
          onClick={() => void recover('reload')}>Kontroller status</button>}
      </div>
    </div>}
    {current && durations ? <>
      {current.subject?.code && <p className="subject-code">{current.subject.code}</p>}
      <h3 className="timer-subject">{current.subject?.name ?? 'Faget er ikke lenger tilgjengelig'}</h3>
      {current.session.description && <p className="timer-description">{current.session.description}</p>}
      <p className="timer-clock"><span className="sr-only">Arbeidstid: </span>{formatDuration(durations.work)}</p>
      <p className="timer-meta">Startet <time dateTime={current.session.started_at}>{localTime(current.session.started_at)}</time>.
        {status === 'paused' && current.segments.length > 0 && <> Pauset <time dateTime={current.segments.at(-1)!.ended_at!}>{localTime(current.segments.at(-1)!.ended_at!)}</time>.</>}
      </p>
      {current.segments.length === 0 && <p className="auth-error">Denne eldre økten har ingen registrerte arbeidsperioder. Arbeidstid før dette oppsettet er ikke kjent.</p>}
      <div className="subject-actions">
        <button type="button" disabled={disabled} onClick={() => void transition({
          action: status === 'running' ? 'pause' : 'resume', sessionId: current.session.id,
          segmentId: status === 'running' ? open!.id : crypto.randomUUID(),
        })}>{status === 'running' ? 'Pause' : 'Fortsett'}</button>
        <button className="text-button" type="button" disabled={disabled}
          onClick={() => void transition({ action: 'stop', sessionId: current.session.id })}>Stopp</button>
      </div>
      <p className="timer-meta">Stopp økten før du bytter fag eller beskrivelse. En pause avslutter ikke økten.</p>
    </> : data.loaded && <form onSubmit={start}>
      {saved && <div className="timer-saved" role="status">
        <p>Økten er lagret.</p>
        <dl><div><dt>Arbeidstid</dt><dd>{formatDuration(saved.work)}</dd></div>
          <div><dt>Pause</dt><dd>{formatDuration(saved.pause)}</dd></div>
          <div><dt>Total klokketid</dt><dd>{formatDuration(saved.elapsed)}</dd></div></dl>
      </div>}
      <fieldset disabled={disabled || subjects.busy || subjects.status !== 'ready' || !active.length}>
        <legend className="sr-only">Registrer en ny studieøkt</legend>
        <div className="auth-field">
          <label htmlFor="session-subject">Fag</label>
          <select id="session-subject" required value={active.some(subject => subject.id === subjectId) ? subjectId : ''}
            onChange={event => setSubjectId(event.target.value)}>
            <option value="">Velg et aktivt fag</option>
            {active.map(subject => <option key={subject.id} value={subject.id}>{subject.code ? subject.code + ' – ' : ''}{subject.name}</option>)}
          </select>
        </div>
        <div className="auth-field">
          <label htmlFor="session-description">Hva jobber du med? <small>(valgfritt)</small></label>
          <textarea id="session-description" rows={2} value={description} aria-describedby="session-help"
            onChange={event => setDescription(event.target.value)} />
          <small id="session-help">Maks 500 tegn.</small>
        </div>
        <button type="submit">Start</button>
      </fieldset>
      {subjects.status === 'ready' && !active.length && <p>Opprett eller aktiver et fag under «Dine fag» først.</p>}
      {subjects.status !== 'ready' && <p>Fagene må hentes før du kan starte. Bruk fagoversikten nedenfor.</p>}
      {validation && <p className="auth-error" role="alert">{validation}</p>}
    </form>}
    {data.loaded && <button className="text-button" type="button" disabled={data.busy}
      onClick={() => void recover('reload')}>Hent status på nytt</button>}
  </section>
}
