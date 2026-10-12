-- Flow v1 foundation. Additive: no Study tables, RPCs or historical work are replaced.
-- subjects -> flow_areas is a temporary ONE-WAY compatibility bridge.
begin;

-- Serialize legacy subject writes through backfill + bridge installation so no
-- concurrent edit/create/delete can fall between the copy and the new trigger.
-- Reads remain available; the lock is released when this migration commits.
lock table public.subjects in share row exclusive mode;

create table public.flow_areas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  code text check (code is null or char_length(code) <= 32),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

-- Keep IDs, ownership and all existing subject fields exactly, not just display names.
insert into public.flow_areas (id, user_id, name, code, is_archived, created_at)
select id, user_id, name, code, is_archived, created_at from public.subjects;

create table public.flow_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  area_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  deadline_at timestamptz check (deadline_at is null or isfinite(deadline_at)),
  status text not null default 'active' check (status in ('active', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (area_id, user_id) references public.flow_areas(id, user_id),
  check ((status = 'active' and completed_at is null) or
    (status = 'completed' and completed_at is not null and isfinite(completed_at)))
);

-- Convert each local 04:00 separately: never assume that a logical day is 24 hours.
-- For rare ambiguous boundaries PostgreSQL uses the post-transition offset.
-- Nonexistent 04:00 boundaries (or skipped dates) are rejected, not silently shifted.
create function public.flow_day_bounds(p_at timestamptz, p_timezone text)
returns table (logical_date date, boundary_at timestamptz, cutoff_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare v_date date; v_start timestamptz; v_end timestamptz;
begin
  if p_at is null or not isfinite(p_at) or p_timezone is null or
     not (p_timezone = 'UTC' or position('/' in p_timezone) > 0) or
     not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'Finite timestamp and IANA timezone required' using errcode = '22023';
  end if;
  v_date := (p_at at time zone p_timezone)::date;
  v_start := (v_date + time '04:00') at time zone p_timezone;
  if p_at < v_start then
    v_date := v_date - 1;
    v_start := (v_date + time '04:00') at time zone p_timezone;
  end if;
  v_end := ((v_date + 1) + time '04:00') at time zone p_timezone;
  if v_start at time zone p_timezone <> v_date + time '04:00' or
     v_end at time zone p_timezone <> (v_date + 1) + time '04:00' or
     v_end <= v_start or p_at < v_start or p_at >= v_end then
    raise exception 'Unrepresentable local 04:00 boundary' using errcode = '22023';
  end if;
  return query select v_date, v_start, v_end;
end;
$$;

create table public.flow_work_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  logical_date date not null,
  timezone text not null,
  boundary_at timestamptz not null,
  cutoff_at timestamptz not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, logical_date),
  check (isfinite(started_at) and isfinite(boundary_at) and isfinite(cutoff_at) and
    boundary_at <= started_at and started_at < cutoff_at),
  check (ended_at is null or (isfinite(ended_at) and ended_at >= started_at and ended_at <= cutoff_at))
);
create unique index flow_one_active_day on public.flow_work_days(user_id) where ended_at is null;

create table public.flow_work_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  work_day_id uuid not null,
  area_id uuid, -- NULL is Annet, not a synthetic area row.
  task_id uuid,
  started_at timestamptz not null check (isfinite(started_at)),
  ended_at timestamptz check (ended_at is null or (isfinite(ended_at) and ended_at >= started_at)),
  created_at timestamptz not null default now(),
  foreign key (work_day_id, user_id) references public.flow_work_days(id, user_id) on delete cascade,
  foreign key (area_id, user_id) references public.flow_areas(id, user_id),
  foreign key (task_id, user_id) references public.flow_tasks(id, user_id)
);
create unique index flow_one_open_segment on public.flow_work_segments(user_id) where ended_at is null;
create index flow_areas_owner on public.flow_areas(user_id);
create index flow_tasks_owner_area on public.flow_tasks(user_id, area_id);
create index flow_segments_day_start on public.flow_work_segments(work_day_id, started_at);
create index flow_segments_owner_area on public.flow_work_segments(user_id, area_id, started_at);
create index flow_segments_owner_task on public.flow_work_segments(user_id, task_id, started_at);

-- Same isolation principle as Study. No ordinary DELETE: archive areas / complete tasks;
-- future reviewed history deletion can be added separately. Auth-user removal still cascades.
do $$
declare v_table text;
begin
  foreach v_table in array array['flow_areas', 'flow_tasks', 'flow_work_days', 'flow_work_segments'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update on public.%I to authenticated', v_table);
    execute format('create policy own_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)', v_table);
    execute format('create policy own_insert on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', v_table);
    execute format('create policy own_update on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', v_table);
  end loop;
end;
$$;

create function public.flow_sync_subject() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- A legacy delete must not erase native work/area attribution.
    update public.flow_areas set is_archived = true where id = old.id and user_id = old.user_id;
    return old;
  end if;
  insert into public.flow_areas (id, user_id, name, code, is_archived, created_at)
  values (new.id, new.user_id, new.name, new.code, new.is_archived, new.created_at)
  on conflict (id) do update set name = excluded.name, code = excluded.code,
    is_archived = excluded.is_archived, created_at = excluded.created_at
    where flow_areas.user_id = excluded.user_id;
  return new;
end;
$$;
create trigger flow_subject_bridge after insert or update or delete on public.subjects
for each row execute function public.flow_sync_subject();

create function public.flow_guard_work_day() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_bounds record;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Ownership mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 9));
  if tg_op = 'INSERT' then
    select * into v_bounds from public.flow_day_bounds(new.started_at, new.timezone);
    -- Client cannot choose a different logical date/cutoff. Persisted bounds stay frozen.
    new.logical_date := v_bounds.logical_date;
    new.boundary_at := v_bounds.boundary_at;
    new.cutoff_at := v_bounds.cutoff_at;
  else
    if (new.id, new.user_id, new.logical_date, new.timezone, new.boundary_at, new.cutoff_at, new.started_at)
       is distinct from (old.id, old.user_id, old.logical_date, old.timezone, old.boundary_at, old.cutoff_at, old.started_at) then
      raise exception 'Work day identity and boundaries are immutable' using errcode = '23514';
    end if;
    if new.ended_at is not null and exists (
      select 1 from public.flow_work_segments where work_day_id = new.id and
        (ended_at is null or ended_at > new.ended_at)) then
      raise exception 'Close segments before ending work day' using errcode = '23514';
    end if;
    if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
      raise exception 'Ended work day cannot be reopened' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger flow_day_guard before insert or update on public.flow_work_days
for each row execute function public.flow_guard_work_day();

create function public.flow_guard_work_segment() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_day public.flow_work_days; v_task public.flow_tasks; v_activity_changed boolean;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Ownership mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 9));
  if tg_op = 'UPDATE' and (new.id, new.user_id, new.work_day_id) is distinct from (old.id, old.user_id, old.work_day_id) then
    raise exception 'Segment identity and owner are immutable' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.ended_at is not null and new.ended_at is null then
    raise exception 'Closed segment cannot be reopened' using errcode = '23514';
  end if;
  select * into v_day from public.flow_work_days where id = new.work_day_id and user_id = new.user_id for share;
  if not found then raise exception 'Work day not found' using errcode = '23503'; end if;
  if new.started_at < v_day.started_at or new.started_at >= v_day.cutoff_at or
     new.ended_at < new.started_at or
     new.ended_at > coalesce(v_day.ended_at, v_day.cutoff_at) or
     (new.ended_at is null and v_day.ended_at is not null) then
    raise exception 'Segment outside work day' using errcode = '23514';
  end if;
  v_activity_changed := tg_op = 'INSERT' or (new.area_id, new.task_id) is distinct from (old.area_id, old.task_id);
  if v_activity_changed and new.task_id is not null then
    select * into v_task from public.flow_tasks where id = new.task_id and user_id = new.user_id for share;
    if not found then raise exception 'Task not found' using errcode = '23503'; end if;
    if new.area_id is distinct from v_task.area_id then
      raise exception 'Segment area must match task area at attribution time' using errcode = '23514';
    end if;
    if new.ended_at is null and v_task.status <> 'active' then
      raise exception 'Task is completed' using errcode = '23514';
    end if;
  end if;
  if v_activity_changed and new.area_id is not null then
    perform 1 from public.flow_areas where id = new.area_id and user_id = new.user_id
      and (new.ended_at is not null or not is_archived) for share;
    if not found then raise exception 'Area unavailable' using errcode = '23503'; end if;
  end if;
  -- Half-open intervals allow touching segments and zero-length closed corrections.
  -- Lock covers all days for this user, including overlapping timezone travel boundaries.
  if exists (select 1 from public.flow_work_segments s
    join public.flow_work_days d on d.id = s.work_day_id and d.user_id = s.user_id
    where s.user_id = new.user_id and s.id <> new.id
    and tstzrange(s.started_at, coalesce(s.ended_at, d.cutoff_at), '[)') &&
      tstzrange(new.started_at, coalesce(new.ended_at, v_day.cutoff_at), '[)')) then
    raise exception 'Work segments overlap' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger flow_segment_guard before insert or update on public.flow_work_segments
for each row execute function public.flow_guard_work_segment();

-- Recovery reconciles at SERVER time, including after sleep/offline/closed tabs.
-- No client-supplied clock argument and no background scheduler required.
create function public.flow_work_day_snapshot(p_work_day_id uuid default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_user uuid := auth.uid(); v_day public.flow_work_days; v_now timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 9));
  v_now := clock_timestamp();
  select * into v_day from public.flow_work_days where user_id = v_user and ended_at is null for update;
  if found and v_now >= v_day.cutoff_at then
    update public.flow_work_segments set ended_at = v_day.cutoff_at
      where work_day_id = v_day.id and user_id = v_user and ended_at is null;
    update public.flow_work_days set ended_at = cutoff_at where id = v_day.id and user_id = v_user;
  end if;
  select * into v_day from public.flow_work_days where user_id = v_user and
    ((p_work_day_id is null and ended_at is null) or id = p_work_day_id);
  if not found then return null; end if;
  return jsonb_build_object('work_day', to_jsonb(v_day), 'segments', coalesce((
    select jsonb_agg(to_jsonb(s) order by s.started_at, s.id) from public.flow_work_segments s
    where s.work_day_id = v_day.id and s.user_id = v_user), '[]'::jsonb), 'server_time', v_now);
end;
$$;

-- Small foundation primitive, not the #11 UI/start-day orchestration.
-- Compare expected open ID before closing+opening in one transaction; new ID is a retry token.
-- NULL next ID pauses; NULL expected ID resumes; two IDs switch activity.
create function public.flow_work_segment_switch(p_work_day_id uuid, p_expected_segment_id uuid,
  p_next_segment_id uuid, p_area_id uuid default null, p_task_id uuid default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_user uuid := auth.uid(); v_day public.flow_work_days; v_open uuid; v_retry_day uuid; v_now timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 9));
  perform public.flow_work_day_snapshot(); -- Reconcile before any activity change.
  select * into v_day from public.flow_work_days where id = p_work_day_id and user_id = v_user for update;
  if not found then raise exception 'Work day not found' using errcode = '22023'; end if;
  if v_day.ended_at is not null then
    return public.flow_work_day_snapshot(p_work_day_id);
  end if;
  if p_next_segment_id is not null then
    select work_day_id into v_retry_day from public.flow_work_segments where id = p_next_segment_id and user_id = v_user;
    if found then
      if v_retry_day <> p_work_day_id then
        raise exception 'Retry token belongs to another day' using errcode = '22023';
      end if;
      return public.flow_work_day_snapshot(p_work_day_id);
    end if;
  end if;
  select id into v_open from public.flow_work_segments where work_day_id = v_day.id and user_id = v_user and ended_at is null;
  if v_open is distinct from p_expected_segment_id then
    return public.flow_work_day_snapshot(p_work_day_id); -- stale action must not close newer work
  end if;
  v_now := greatest(clock_timestamp(), v_day.started_at, coalesce((
    select max(coalesce(ended_at, started_at)) from public.flow_work_segments where work_day_id = v_day.id), v_day.started_at));
  if v_now >= v_day.cutoff_at then
    -- Time may have crossed cutoff since the first reconciliation.
    perform public.flow_work_day_snapshot();
    return public.flow_work_day_snapshot(p_work_day_id);
  end if;
  if v_open is not null then update public.flow_work_segments set ended_at = v_now where id = v_open and user_id = v_user; end if;
  if p_next_segment_id is not null then
    insert into public.flow_work_segments(id, user_id, work_day_id, area_id, task_id, started_at)
      values (p_next_segment_id, v_user, v_day.id, p_area_id, p_task_id, v_now);
  end if;
  return public.flow_work_day_snapshot(p_work_day_id);
end;
$$;

-- Trigger functions are not callable APIs. Default Supabase privileges are explicitly removed.
revoke all on function public.flow_sync_subject() from public, anon, authenticated;
revoke all on function public.flow_guard_work_day() from public, anon, authenticated;
revoke all on function public.flow_guard_work_segment() from public, anon, authenticated;
revoke all on function public.flow_day_bounds(timestamptz, text) from public, anon, authenticated;
revoke all on function public.flow_work_day_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.flow_work_segment_switch(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.flow_day_bounds(timestamptz, text) to authenticated;
grant execute on function public.flow_work_day_snapshot(uuid) to authenticated;
grant execute on function public.flow_work_segment_switch(uuid, uuid, uuid, uuid, uuid) to authenticated;

commit;
