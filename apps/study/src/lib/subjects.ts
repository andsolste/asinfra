import type { SupabaseClient } from '@supabase/supabase-js'

export type Subject = {
  id: string
  name: string
  code: string | null
  is_archived: boolean
  created_at: string
}

export type SubjectInput = { name: string; code: string }
const columns = 'id,name,code,is_archived,created_at'
const length = (value: string) => Array.from(value).length

export function validateSubject(input: SubjectInput) {
  const name = input.name.trim()
  const code = input.code.trim() || null
  if (!name) throw new Error('Fagnavn er påkrevd.')
  if (length(name) > 120) throw new Error('Fagnavn kan ha maks 120 tegn.')
  if (code && length(code) > 32) throw new Error('Fagkode kan ha maks 32 tegn.')
  return { name, code }
}

export function mapSubject(value: unknown): Subject {
  if (!value || typeof value !== 'object') throw new Error('Ugyldige fagdata.')
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id
    || typeof row.name !== 'string' || !row.name.trim()
    || !(row.code === null || typeof row.code === 'string')
    || typeof row.is_archived !== 'boolean'
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) {
    throw new Error('Ugyldige fagdata.')
  }
  return { id: row.id, name: row.name, code: row.code, is_archived: row.is_archived, created_at: row.created_at }
}

export function splitSubjects(subjects: Subject[]) {
  return {
    active: subjects.filter(subject => !subject.is_archived),
    archived: subjects.filter(subject => subject.is_archived),
  }
}

// Returned rows are the source of truth; no user_id, deletion or optimistic writes.
export function createSubjectApi(client: Pick<SupabaseClient, 'from'>) {
  return {
    async list(signal: AbortSignal): Promise<Subject[]> {
      try {
        const { data, error } = await client.from('subjects').select(columns)
          .order('created_at', { ascending: true }).order('id', { ascending: true }).abortSignal(signal)
        if (error || !Array.isArray(data)) throw new Error()
        return data.map(mapSubject)
      } catch { throw new Error('Kunne ikke hente fagene dine.') }
    },
    async create(input: SubjectInput, signal: AbortSignal): Promise<Subject> {
      const values = validateSubject(input)
      try {
        const { data, error } = await client.from('subjects').insert(values).select(columns).abortSignal(signal).single()
        if (error) throw new Error()
        return mapSubject(data)
      } catch { throw new Error('Kunne ikke opprette faget. Kontroller listen før du prøver igjen.') }
    },
    async edit(id: string, input: SubjectInput, signal: AbortSignal): Promise<Subject> {
      const values = validateSubject(input)
      try {
        const { data, error } = await client.from('subjects').update(values).eq('id', id).select(columns).abortSignal(signal).single()
        if (error) throw new Error()
        return mapSubject(data)
      } catch { throw new Error('Kunne ikke lagre endringene.') }
    },
    async setArchived(id: string, archived: boolean, signal: AbortSignal): Promise<Subject> {
      try {
        const { data, error } = await client.from('subjects').update({ is_archived: archived })
          .eq('id', id).select(columns).abortSignal(signal).single()
        if (error) throw new Error()
        return mapSubject(data)
      } catch { throw new Error(archived ? 'Kunne ikke arkivere faget.' : 'Kunne ikke aktivere faget.') }
    },
  }
}
