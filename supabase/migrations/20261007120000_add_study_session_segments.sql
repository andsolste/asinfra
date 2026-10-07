begin;

-- Do not silently finish existing sessions to make this index fit. Review any
-- duplicate unfinished rows before applying this migration.
alter table public.study_sessions add constraint study_sessions_id_owner_unique unique (id, user_id);
create unique index study_sessions_one_active_per_user
    on public.study_sessions(user_id) where ended_at is null;

create table public.study_session_segments (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    started_at timestamptz not null,
    ended_at timestamptz check (ended_at is null or ended_at >= started_at),
    created_at timestamptz not null default now(),
    foreign key (session_id, user_id) references public.study_sessions(id, user_id) on delete cascade
);
create index study_session_segments_owner_idx on public.study_session_segments(user_id);
create index study_session_segments_session_started_idx on public.study_session_segments(session_id, started_at);
create unique index study_session_segments_one_open
    on public.study_session_segments(session_id) where ended_at is null;

alter table public.study_session_segments enable row level security;
revoke all on public.study_session_segments from public, anon, authenticated;
grant select, insert, update, delete on public.study_session_segments to authenticated;
create policy study_session_segments_select_own on public.study_session_segments for select to authenticated
    using ((select auth.uid()) = user_id);
create policy study_session_segments_insert_own on public.study_session_segments for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy study_session_segments_update_own on public.study_session_segments for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy study_session_segments_delete_own on public.study_session_segments for delete to authenticated
    using ((select auth.uid()) = user_id);

-- SECURITY INVOKER: normal authenticated grants and RLS apply to every query.
-- Serialize snapshots and transitions for this user, including across tabs.
create function public.study_session_snapshot(p_session_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_session public.study_sessions%rowtype;
    v_subject jsonb;
    v_segments jsonb;
begin
    if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 9));
    select * into v_session from public.study_sessions
        where user_id = auth.uid() and
            ((p_session_id is null and ended_at is null) or id = p_session_id);
    if not found then return null; end if;
    select jsonb_build_object('id', id, 'name', name, 'code', code, 'is_archived', is_archived, 'created_at', created_at)
        into v_subject from public.subjects where id = v_session.subject_id;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'session_id', session_id,
        'started_at', started_at, 'ended_at', ended_at) order by started_at, id), '[]'::jsonb)
        into v_segments from public.study_session_segments where session_id = v_session.id;
    return jsonb_build_object('session', jsonb_build_object('id', v_session.id,
        'subject_id', v_session.subject_id, 'description', v_session.description,
        'started_at', v_session.started_at, 'ended_at', v_session.ended_at),
        'subject', v_subject, 'segments', v_segments, 'server_time', clock_timestamp());
end;
$$;

-- Start/stop update two tables in one transaction: never a half-saved timer.
-- Client UUIDs are only idempotency IDs, not trusted ownership or timestamps.
create function public.study_session_transition(
    p_action text, p_session_id uuid, p_subject_id uuid default null,
    p_description text default '', p_segment_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_session public.study_sessions%rowtype;
    v_now timestamptz;
begin
    if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
    if p_session_id is null or p_action not in ('start', 'pause', 'resume', 'stop') or p_action is null then
        raise exception 'Invalid transition' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 9));
    select * into v_session from public.study_sessions where id = p_session_id for update;
    if p_action = 'start' then
        -- Retrying a committed start never creates another session, even after stop.
        if found then return public.study_session_snapshot(p_session_id); end if;
        if p_segment_id is null then raise exception 'Segment ID required' using errcode = '22023'; end if;
        perform id from public.subjects where id = p_subject_id and not is_archived for share;
        if not found then raise exception 'Active subject required' using errcode = '22023'; end if;
        v_now := clock_timestamp();
        insert into public.study_sessions(id, subject_id, description, started_at)
            values (p_session_id, p_subject_id, btrim(p_description), v_now);
        insert into public.study_session_segments(id, session_id, started_at)
            values (p_segment_id, p_session_id, v_now);
    else
        if not found then raise exception 'Session not found' using errcode = '22023'; end if;
        -- A stale tab or a retry cannot resurrect a finished session.
        if v_session.ended_at is not null then return public.study_session_snapshot(p_session_id); end if;
        v_now := greatest(clock_timestamp(), v_session.started_at,
            coalesce((select max(coalesce(ended_at, started_at)) from public.study_session_segments
                where session_id = p_session_id), v_session.started_at));
        if p_action = 'pause' then
            if p_segment_id is null then raise exception 'Segment ID required' using errcode = '22023'; end if;
            -- Only close the segment the caller saw; a stale pause must not
            -- close a newer segment started in a different tab.
            update public.study_session_segments set ended_at = v_now
                where id = p_segment_id and session_id = p_session_id and ended_at is null;
        elsif p_action = 'resume' then
            if p_segment_id is null then raise exception 'Segment ID required' using errcode = '22023'; end if;
            if not exists (select 1 from public.study_session_segments where id = p_segment_id)
                and not exists (select 1 from public.study_session_segments
                    where session_id = p_session_id and ended_at is null) then
                insert into public.study_session_segments(id, session_id, started_at)
                    values (p_segment_id, p_session_id, v_now);
            end if;
        else
            update public.study_session_segments set ended_at = v_now
                where session_id = p_session_id and ended_at is null;
            update public.study_sessions set ended_at = v_now where id = p_session_id;
        end if;
    end if;
    return public.study_session_snapshot(p_session_id);
end;
$$;
revoke all on function public.study_session_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.study_session_transition(text, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.study_session_snapshot(uuid) to authenticated;
grant execute on function public.study_session_transition(text, uuid, uuid, text, uuid) to authenticated;

commit;
