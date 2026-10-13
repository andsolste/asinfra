-- Phase #11: server-side cutover + atomic first activity. No old migrations/data rewritten.
begin;

-- Prevent a concurrent timer write from slipping through while guards are installed.
lock table public.study_sessions, public.study_session_segments,
  public.flow_work_days, public.flow_work_segments in share row exclusive mode;

create table public.flow_timer_cutovers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  activated_at timestamptz not null check (isfinite(activated_at))
);
alter table public.flow_timer_cutovers enable row level security;
revoke all on public.flow_timer_cutovers from public, anon, authenticated;
grant select, insert on public.flow_timer_cutovers to authenticated;
create policy own_read on public.flow_timer_cutovers for select to authenticated
  using ((select auth.uid()) = user_id);
create policy own_insert on public.flow_timer_cutovers for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Foundation data may already exist. Never silently truncate ambiguous parallel work.
do $$ begin
  if exists (select 1 from public.flow_work_days d join public.study_sessions s
    on s.user_id = d.user_id where s.ended_at is null) then
    raise exception 'Review existing native days with unfinished legacy sessions before cutover migration';
  end if;
  if exists (select 1 from public.flow_work_days d where not exists (
    select 1 from public.flow_work_segments s where s.work_day_id = d.id and s.started_at = d.started_at)) then
    raise exception 'Review native days without first activity before cutover migration';
  end if;
  if exists (select 1 from public.study_session_segments s join (
    select user_id, min(started_at) as first_start from public.flow_work_days group by user_id
  ) d on d.user_id = s.user_id where s.ended_at > s.started_at and s.ended_at > d.first_start) then
    raise exception 'Review legacy work after existing native start before cutover migration';
  end if;
end $$;
insert into public.flow_timer_cutovers(user_id, activated_at)
  select user_id, min(started_at) from public.flow_work_days group by user_id;

create function public.flow_guard_cutover() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_start timestamptz;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Ownership mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 9));
  select min(started_at) into v_start from public.flow_work_days where user_id = new.user_id;
  if v_start is null then raise exception 'Native work day required' using errcode = '23514'; end if;
  new.activated_at := v_start; -- not a client-supplied cutover clock
  return new;
end $$;
create trigger flow_cutover_guard before insert on public.flow_timer_cutovers
  for each row execute function public.flow_guard_cutover();

create function public.flow_mark_cutover() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.flow_timer_cutovers(user_id, activated_at) values(new.user_id, new.started_at)
    on conflict (user_id) do nothing;
  return new;
end $$;
create trigger flow_day_cutover after insert on public.flow_work_days
  for each row execute function public.flow_mark_cutover();

-- Invoker RPCs need table INSERT grants. A deferred constraint prevents those
-- grants being used for a half-saved standalone day/cutover via direct Data API.
create function public.flow_require_first_activity() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.flow_work_segments where work_day_id = new.id
    and user_id = new.user_id and started_at = new.started_at) then
    raise exception 'Day and first activity must be created together' using errcode = '23514';
  end if;
  return new;
end $$;
create constraint trigger flow_day_first_activity after insert on public.flow_work_days
  deferrable initially deferred for each row execute function public.flow_require_first_activity();

-- Row guards protect BOTH old RPCs and direct table writes. History/read/delete
-- remain available; a correction may not extend legacy work past its cutover.
create function public.flow_guard_legacy_timer() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_cutover timestamptz;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Ownership mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 9));
  select activated_at into v_cutover from public.flow_timer_cutovers where user_id = new.user_id;
  if found and (new.ended_at is null or new.ended_at > v_cutover) then
    raise exception 'Legacy timer retired for this user; refresh Flow' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger flow_legacy_session_guard before insert or update on public.study_sessions
  for each row execute function public.flow_guard_legacy_timer();
create trigger flow_legacy_segment_guard before insert or update on public.study_session_segments
  for each row execute function public.flow_guard_legacy_timer();

create function public.flow_guard_native_timer() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_cutover timestamptz; v_end timestamptz;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Ownership mismatch' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 9));
  if exists (select 1 from public.study_sessions where user_id = new.user_id and ended_at is null) then
    raise exception 'Reconcile legacy timer before native work' using errcode = '23514';
  end if;
  select activated_at into v_cutover from public.flow_timer_cutovers where user_id = new.user_id;
  if found and new.started_at < v_cutover then
    raise exception 'Native work cannot precede cutover' using errcode = '23514';
  end if;
  if tg_table_name = 'flow_work_segments' and (new.ended_at is null or new.ended_at > new.started_at) then
    select coalesce(new.ended_at, cutoff_at) into v_end from public.flow_work_days
      where id = new.work_day_id and user_id = new.user_id;
    if exists (select 1 from public.study_session_segments where user_id = new.user_id
      and ended_at > started_at and ended_at > new.started_at and started_at < v_end) then
      raise exception 'Native work overlaps legacy history' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger flow_native_day_guard before insert on public.flow_work_days
  for each row execute function public.flow_guard_native_timer();
create trigger flow_native_segment_guard before insert or update on public.flow_work_segments
  for each row execute function public.flow_guard_native_timer();

-- Read-only orchestration (apart from authoritative cutoff reconciliation).
-- Supplies an expected boundary token even when no work day exists. Missing or
-- invalid browser timezone does not prevent recovery of an already frozen day.
create function public.flow_work_state(p_timezone text default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_user uuid := auth.uid(); v_current jsonb; v_now timestamptz; v_bounds record;
  v_boundary timestamptz; v_cutoff timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 9));
  v_current := public.flow_work_day_snapshot();
  v_now := clock_timestamp();
  begin
    select * into v_bounds from public.flow_day_bounds(v_now, p_timezone);
    v_boundary := v_bounds.boundary_at; v_cutoff := v_bounds.cutoff_at;
  exception when invalid_parameter_value then
    v_boundary := null; v_cutoff := null;
  end;
  return jsonb_build_object('current', v_current, 'server_time', v_now,
    'next_boundary_at', v_boundary, 'next_cutoff_at', v_cutoff,
    'legacy_active', exists(select 1 from public.study_sessions where user_id = v_user and ended_at is null));
end $$;

create function public.flow_work_day_start(p_work_day_id uuid, p_segment_id uuid,
  p_timezone text, p_expected_boundary_at timestamptz,
  p_area_id uuid default null, p_task_id uuid default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_user uuid := auth.uid(); v_now timestamptz; v_bounds record; v_current jsonb;
  v_existing uuid; v_legacy public.study_sessions; v_last timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_work_day_id is null or p_segment_id is null then
    raise exception 'Retry IDs required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 9));
  v_current := public.flow_work_day_snapshot();
  -- A replay, even days later, never creates new work or resurrects a closed row.
  select id into v_existing from public.flow_work_days where id = p_work_day_id and user_id = v_user;
  if found then return coalesce(v_current, public.flow_work_day_snapshot(v_existing)); end if;
  select work_day_id into v_existing from public.flow_work_segments where id = p_segment_id and user_id = v_user;
  if found then raise exception 'Retry token already used' using errcode = '22023'; end if;
  if v_current is not null then return v_current; end if; -- stale idle tab must not switch another tab's work
  v_now := clock_timestamp();
  select * into v_bounds from public.flow_day_bounds(v_now, p_timezone);
  if p_expected_boundary_at is null or p_expected_boundary_at is distinct from v_bounds.boundary_at then
    raise exception 'Flow boundary changed; refresh before starting' using errcode = '22023';
  end if;
  if exists (select 1 from public.flow_work_days where user_id = v_user and logical_date = v_bounds.logical_date) then
    raise exception 'This logical day is already ended' using errcode = '22023';
  end if;
  if exists (select 1 from public.study_session_segments where user_id = v_user
    and ended_at > started_at and ended_at > v_now) then
    raise exception 'Review future-dated legacy work before cutover' using errcode = '22023';
  end if;
  select * into v_legacy from public.study_sessions where user_id = v_user and ended_at is null for update;
  if found then
    select max(coalesce(ended_at, started_at)) into v_last from public.study_session_segments
      where session_id = v_legacy.id and user_id = v_user;
    if not isfinite(v_legacy.started_at) or v_legacy.started_at > v_now or v_last > v_now then
      raise exception 'Review future-dated legacy work before cutover' using errcode = '22023';
    end if;
    update public.study_session_segments set ended_at = v_now
      where session_id = v_legacy.id and user_id = v_user and ended_at is null;
    update public.study_sessions set ended_at = v_now where id = v_legacy.id and user_id = v_user;
  end if;
  -- Trigger computes/fixes boundaries and creates durable cutover marker. If the
  -- first activity is invalid ALL of this, including legacy close, rolls back.
  insert into public.flow_work_days(id,user_id,logical_date,timezone,boundary_at,cutoff_at,started_at)
    values(p_work_day_id,v_user,v_bounds.logical_date,p_timezone,v_bounds.boundary_at,v_bounds.cutoff_at,v_now);
  insert into public.flow_work_segments(id,user_id,work_day_id,area_id,task_id,started_at)
    values(p_segment_id,v_user,p_work_day_id,p_area_id,p_task_id,v_now);
  return public.flow_work_day_snapshot(p_work_day_id);
end $$;

-- Segment-count version also protects a delayed resume across an entire intervening
-- work/pause cycle, where expected open ID alone would be NULL both times.
create function public.flow_work_activity(p_work_day_id uuid, p_expected_segment_id uuid,
  p_expected_segment_count integer, p_next_segment_id uuid,
  p_area_id uuid default null, p_task_id uuid default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_user uuid := auth.uid(); v_count integer; v_current jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 9));
  perform public.flow_work_day_snapshot();
  v_current := public.flow_work_day_snapshot(p_work_day_id);
  if v_current is null then raise exception 'Work day not found' using errcode = '22023'; end if;
  if p_next_segment_id is not null and exists(select 1 from public.flow_work_segments
    where id = p_next_segment_id and work_day_id = p_work_day_id and user_id = v_user) then
    return v_current;
  end if;
  select count(*) into v_count from public.flow_work_segments where work_day_id = p_work_day_id and user_id = v_user;
  if v_count is distinct from p_expected_segment_count then return v_current; end if;
  return public.flow_work_segment_switch(p_work_day_id, p_expected_segment_id,
    p_next_segment_id, p_area_id, p_task_id);
end $$;

revoke all on function public.flow_guard_cutover(), public.flow_mark_cutover(),
  public.flow_guard_legacy_timer(), public.flow_guard_native_timer(), public.flow_require_first_activity() from public, anon, authenticated;
revoke all on function public.flow_work_state(text), public.flow_work_activity(uuid,uuid,integer,uuid,uuid,uuid),
  public.flow_work_day_start(uuid,uuid,text,timestamptz,uuid,uuid) from public, anon, authenticated;
grant execute on function public.flow_work_state(text), public.flow_work_activity(uuid,uuid,integer,uuid,uuid,uuid),
  public.flow_work_day_start(uuid,uuid,text,timestamptz,uuid,uuid) to authenticated;
commit;
