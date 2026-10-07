import type { SupabaseClient } from '@supabase/supabase-js'
import { mapSubject } from './subjects.ts'
import type { Subject } from './subjects.ts'

export type WorkSegment = { id: string; session_id: string; started_at: string; ended_at: string | null }
export type StudySession = { id: string; subject_id: string | null; description: string; started_at: string; ended_at: string | null }
export type SessionSnapshot = { session: StudySession; subject: Subject | null; segments: WorkSegment[]; server_time: string }
export type SessionCommand = {
  action: 'start' | 'pause' | 'resume' | 'stop'
  sessionId: string
  subjectId?: string
  description?: string
  segmentId?: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ugyldige øktdata.')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Ugyldige øktdata.')
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Ugyldige tidspunkt.')
  return value
}
const nullableTime = (value: unknown) => value === null ? null : timestamp(value)

export function mapSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (value === null) return null
  const row = record(value), source = record(row.session)
  const session: StudySession = {
    id: id(source.id), subject_id: source.subject_id === null ? null : id(source.subject_id),
    description: typeof source.description === 'string' ? source.description : '',
    started_at: timestamp(source.started_at), ended_at: nullableTime(source.ended_at),
  }
  if (typeof source.description !== 'string' || Array.from(session.description).length > 500
    || !Array.isArray(row.segments)) throw new Error('Ugyldige øktdata.')
  const segments = row.segments.map(value => {
    const segment = record(value)
    return { id: id(segment.id), session_id: id(segment.session_id),
      started_at: timestamp(segment.started_at), ended_at: nullableTime(segment.ended_at) }
  }).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
  let lastEnd = Date.parse(session.started_at)
  const seen = new Set<string>()
  for (const segment of segments) {
    const start = Date.parse(segment.started_at), end = segment.ended_at ? Date.parse(segment.ended_at) : Infinity
    if (segment.session_id !== session.id || seen.has(segment.id) || start < lastEnd || end < start
      || (session.ended_at && end > Date.parse(session.ended_at))) throw new Error('Ugyldige arbeidsperioder.')
    seen.add(segment.id); lastEnd = end
  }
  if (session.ended_at && Date.parse(session.ended_at) < Date.parse(session.started_at)) throw new Error('Ugyldige tidspunkt.')
  const subject = row.subject === null ? null : mapSubject(row.subject)
  if (subject && subject.id !== session.subject_id) throw new Error('Ugyldig fagkobling.')
  return { session, subject, segments, server_time: timestamp(row.server_time) }
}

export function sessionStatus(snapshot: SessionSnapshot) {
  return snapshot.session.ended_at ? 'finished'
    : snapshot.segments.some(segment => segment.ended_at === null) ? 'running' : 'paused'
}
export function sessionDurations(snapshot: SessionSnapshot, now = Date.now()) {
  const end = snapshot.session.ended_at ? Date.parse(snapshot.session.ended_at) : now
  const elapsed = Math.max(0, end - Date.parse(snapshot.session.started_at))
  const work = snapshot.segments.reduce((total, segment) => total + Math.max(0,
    (segment.ended_at ? Date.parse(segment.ended_at) : end) - Date.parse(segment.started_at)), 0)
  return { work, elapsed, pause: Math.max(0, elapsed - work) }
}
export function formatDuration(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
}
export function validateSessionInput(subjectId: string, description: string, subjects: Subject[]) {
  if (!subjects.some(subject => subject.id === subjectId && !subject.is_archived)) throw new Error('Velg et aktivt fag.')
  const text = description.trim()
  if (Array.from(text).length > 500) throw new Error('Beskrivelsen kan ha maks 500 tegn.')
  return text
}

export function createSessionApi(client: Pick<SupabaseClient, 'rpc'>) {
  return {
    async load(signal: AbortSignal, sessionId?: string) {
      const { data, error } = await client.rpc('study_session_snapshot', { p_session_id: sessionId ?? null }).abortSignal(signal)
      if (error) throw new Error('Kunne ikke hente økten.')
      return mapSessionSnapshot(data)
    },
    async transition(command: SessionCommand, signal: AbortSignal) {
      const { data, error } = await client.rpc('study_session_transition', {
        p_action: command.action, p_session_id: command.sessionId,
        p_subject_id: command.subjectId ?? null, p_description: command.description ?? '',
        p_segment_id: command.segmentId ?? null,
      }).abortSignal(signal)
      if (error || data === null) throw new Error('Kunne ikke lagre økten.')
      return mapSessionSnapshot(data)!
    },
  }
}
