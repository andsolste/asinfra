import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { createSubjectApi } from '../lib/subjects'
import type { Subject, SubjectInput } from '../lib/subjects'

const api = supabase ? createSubjectApi(supabase) : null

export function useSubjects() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!api || request.current) return
    const controller = new AbortController()
    request.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setBusy(true); setStatus('loading'); setError(null); setNotice('')
    try {
      const rows = await api.list(controller.signal)
      if (request.current !== controller) return
      setSubjects(rows); setStatus('ready')
    } catch {
      if (request.current === controller) {
        setStatus('error'); setError('Kunne ikke hente fagene dine. Prøv igjen.')
      }
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { request.current?.abort(); request.current = null }
  }, [load])

  async function mutate(operation: (signal: AbortSignal) => Promise<Subject>, message: string, failure: string) {
    if (request.current || status !== 'ready') return false
    const controller = new AbortController()
    request.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setBusy(true); setError(null); setNotice('')
    try {
      const saved = await operation(controller.signal)
      if (request.current !== controller) return false
      setSubjects(rows => rows.some(row => row.id === saved.id)
        ? rows.map(row => row.id === saved.id ? saved : row) : [...rows, saved])
      setNotice(message)
      return true
    } catch {
      if (request.current === controller) {
        // An interrupted write may have reached the DB. Require a fresh list before retry.
        setStatus('error'); setError(`${failure} Hent fagene på nytt før du prøver igjen.`)
      }
      return false
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return {
    subjects, status, busy, error, notice, reload: load,
    save: (input: SubjectInput, id?: string) => api
      ? mutate(signal => id ? api.edit(id, input, signal) : api.create(input, signal),
        id ? 'Endringene er lagret.' : 'Faget er opprettet.', id ? 'Kunne ikke lagre endringene.' : 'Kunne ikke opprette faget.')
      : Promise.resolve(false),
    setArchived: (subject: Subject) => api
      ? mutate(signal => api.setArchived(subject.id, !subject.is_archived, signal),
        subject.is_archived ? 'Faget er aktivt igjen.' : 'Faget er arkivert.',
        subject.is_archived ? 'Kunne ikke aktivere faget.' : 'Kunne ikke arkivere faget.')
      : Promise.resolve(false),
  }
}
