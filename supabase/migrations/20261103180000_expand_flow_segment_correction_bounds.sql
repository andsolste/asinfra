-- Correct recorded work within frozen logical-day bounds. No data backfill.
begin;
lock table public.study_sessions,public.study_session_segments,
  public.flow_work_days,public.flow_work_segments in share row exclusive mode;

-- ended_at is the immutable lifecycle close, not a ceiling on corrected work.
alter table public.flow_work_days drop constraint flow_work_days_check1;
alter table public.flow_work_days add constraint flow_day_close_bounds check
  (ended_at is null or (isfinite(ended_at) and boundary_at<=ended_at and ended_at<=cutoff_at));

create or replace function public.flow_guard_work_day() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_bounds record; v_first timestamptz;
begin
  if auth.uid() is not null and new.user_id<>auth.uid() then
    raise exception 'Ownership mismatch' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
  if tg_op='INSERT' then
    select * into v_bounds from public.flow_day_bounds(new.started_at,new.timezone);
    new.logical_date:=v_bounds.logical_date; new.boundary_at:=v_bounds.boundary_at; new.cutoff_at:=v_bounds.cutoff_at;
    if new.ended_at<new.started_at then raise exception 'Close precedes initial activity' using errcode='23514'; end if;
  else
    if (new.id,new.user_id,new.logical_date,new.timezone,new.boundary_at,new.cutoff_at,new.created_at)
      is distinct from (old.id,old.user_id,old.logical_date,old.timezone,old.boundary_at,old.cutoff_at,old.created_at) then
      raise exception 'Work day identity and boundaries are immutable' using errcode='23514';
    end if;
    if new.started_at is distinct from old.started_at then
      select min(started_at) into v_first from public.flow_work_segments where work_day_id=new.id and user_id=new.user_id;
      if new.started_at is distinct from v_first then
        raise exception 'Day start must equal first recorded period' using errcode='23514';
      end if;
    end if;
    if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
      raise exception 'Ended work day cannot be reopened' using errcode='23514';
    end if;
    if new.ended_at is distinct from old.ended_at and new.ended_at is not null and exists (
      select 1 from public.flow_work_segments where work_day_id=new.id and user_id=new.user_id
        and (ended_at is null or ended_at>new.ended_at)) then
      raise exception 'Close segments before ending work day' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.flow_guard_work_segment() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_day public.flow_work_days; v_task public.flow_tasks; v_activity_changed boolean;
begin
  if auth.uid() is not null and new.user_id<>auth.uid() then raise exception 'Ownership mismatch' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
  if tg_op='UPDATE' and (new.id,new.user_id,new.work_day_id) is distinct from (old.id,old.user_id,old.work_day_id) then
    raise exception 'Segment identity and owner are immutable' using errcode='23514';
  end if;
  if tg_op='UPDATE' and old.ended_at is not null and new.ended_at is null then
    raise exception 'Closed segment cannot be reopened' using errcode='23514';
  end if;
  select * into v_day from public.flow_work_days where id=new.work_day_id and user_id=new.user_id for share;
  if not found then raise exception 'Work day not found' using errcode='23503'; end if;
  if new.started_at<v_day.boundary_at or new.started_at>=v_day.cutoff_at or new.ended_at<new.started_at
    or new.ended_at>v_day.cutoff_at or (new.ended_at is null and v_day.ended_at is not null) then
    raise exception 'Segment outside work day' using errcode='23514';
  end if;
  if new.ended_at>clock_timestamp() then raise exception 'Period ends in future' using errcode='22008'; end if;
  -- A new day still requires its real first activity in the same transaction.
  if tg_op='INSERT' and not exists(select 1 from public.flow_work_segments where work_day_id=new.work_day_id and user_id=new.user_id)
    and new.started_at is distinct from v_day.started_at then
    raise exception 'Day and first activity must be created together' using errcode='23514';
  end if;
  v_activity_changed:=tg_op='INSERT' or (new.area_id,new.task_id) is distinct from (old.area_id,old.task_id);
  if v_activity_changed and new.task_id is not null then
    select * into v_task from public.flow_tasks where id=new.task_id and user_id=new.user_id for share;
    if not found then raise exception 'Task not found' using errcode='23503'; end if;
    if new.area_id is distinct from v_task.area_id then raise exception 'Segment area must match task area at attribution time' using errcode='23514'; end if;
    if new.ended_at is null and v_task.status<>'active' then raise exception 'Task is completed' using errcode='23514'; end if;
  end if;
  if v_activity_changed and new.area_id is not null then
    perform 1 from public.flow_areas where id=new.area_id and user_id=new.user_id and (new.ended_at is not null or not is_archived) for share;
    if not found then raise exception 'Area unavailable' using errcode='23503'; end if;
  end if;
  if exists(select 1 from public.flow_work_segments s join public.flow_work_days d on d.id=s.work_day_id and d.user_id=s.user_id
    where s.user_id=new.user_id and s.id<>new.id and tstzrange(s.started_at,coalesce(s.ended_at,d.cutoff_at),'[)') &&
      tstzrange(new.started_at,coalesce(new.ended_at,v_day.cutoff_at),'[)')) then
    raise exception 'Work segments overlap' using errcode='23514';
  end if;
  return new;
end $$;

-- Only a derived value can change: no GUC/flag or SECURITY DEFINER bypass.
create function public.flow_sync_day_start() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update public.flow_work_days d set started_at=(select min(s.started_at) from public.flow_work_segments s where s.work_day_id=d.id and s.user_id=d.user_id)
    where d.id=new.work_day_id and d.user_id=new.user_id and d.started_at is distinct from
      (select min(s.started_at) from public.flow_work_segments s where s.work_day_id=d.id and s.user_id=d.user_id);
  return new;
end $$;
create trigger flow_segment_day_start after insert or update of started_at on public.flow_work_segments
  for each row execute function public.flow_sync_day_start();
revoke all on function public.flow_sync_day_start() from public,anon,authenticated;

create or replace function public.flow_require_first_activity() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  -- At commit use the derived current start, not a pre-correction INSERT tuple.
  if exists(select 1 from public.flow_work_days d where d.id=new.id and d.user_id=new.user_id and not exists (
    select 1 from public.flow_work_segments s where s.work_day_id=d.id and s.user_id=d.user_id and s.started_at=d.started_at)) then
    raise exception 'Day and first activity must be created together' using errcode='23514';
  end if;
  return new;
end $$;

-- The durable activation marker is never moved: old clients remain retired.
-- Closed native corrections may predate activation within their frozen day,
-- provided there is no actual legacy work there. Inserts/open writes retain the barrier.
create or replace function public.flow_guard_native_timer() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_cutover timestamptz; v_end timestamptz;
begin
  if auth.uid() is not null and new.user_id<>auth.uid() then raise exception 'Ownership mismatch' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
  if exists(select 1 from public.study_sessions where user_id=new.user_id and ended_at is null) then
    raise exception 'Reconcile legacy timer before native work' using errcode='23514';
  end if;
  select activated_at into v_cutover from public.flow_timer_cutovers where user_id=new.user_id;
  if found and new.started_at<v_cutover then
    if tg_table_name<>'flow_work_segments' or tg_op<>'UPDATE' then
      raise exception 'Native work cannot precede cutover' using errcode='23514';
    end if;
    if old.ended_at is null or new.ended_at is null then
      raise exception 'Native work cannot precede cutover' using errcode='23514';
    end if;
  end if;
  if tg_table_name='flow_work_segments' and (new.ended_at is null or new.ended_at>new.started_at) then
    select coalesce(new.ended_at,cutoff_at) into v_end from public.flow_work_days where id=new.work_day_id and user_id=new.user_id;
    if exists(select 1 from public.study_session_segments where user_id=new.user_id and ended_at>started_at
      and ended_at>new.started_at and started_at<v_end) then
      raise exception 'Native work overlaps legacy history' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.flow_guard_legacy_timer() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_cutover timestamptz;
begin
  if auth.uid() is not null and new.user_id<>auth.uid() then raise exception 'Ownership mismatch' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
  select activated_at into v_cutover from public.flow_timer_cutovers where user_id=new.user_id;
  if found and (new.ended_at is null or new.ended_at>v_cutover) then
    raise exception 'Legacy timer retired for this user; refresh Flow' using errcode='23514';
  end if;
  -- Symmetric protection: a later old-client edit cannot invade corrected Flow work.
  if tg_table_name='study_session_segments' and new.ended_at>new.started_at and exists (
    select 1 from public.flow_work_segments s join public.flow_work_days d on d.id=s.work_day_id and d.user_id=s.user_id
    where s.user_id=new.user_id and (s.ended_at is null or s.ended_at>s.started_at)
      and new.started_at<coalesce(s.ended_at,d.cutoff_at) and new.ended_at>s.started_at) then
    raise exception 'Legacy work overlaps native history' using errcode='23514';
  end if;
  return new;
end $$;

create or replace function public.flow_work_segment_correct(
  p_segment_id uuid,p_work_day_id uuid,p_expected_started_at timestamptz,p_expected_ended_at timestamptz,
  p_expected_area_id uuid,p_expected_task_id uuid,p_started_at timestamptz,p_ended_at timestamptz,p_area_id uuid,p_task_id uuid
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_segment public.flow_work_segments; v_day public.flow_work_days; v_now timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  perform public.flow_work_day_snapshot();
  select * into v_segment from public.flow_work_segments where id=p_segment_id and work_day_id=p_work_day_id and user_id=v_user for update;
  if not found then raise exception 'Work period unavailable' using errcode='42501'; end if;
  select * into v_day from public.flow_work_days where id=v_segment.work_day_id and user_id=v_user for update;
  v_now:=clock_timestamp();
  if p_expected_started_at is null or not isfinite(p_expected_started_at) or (p_expected_ended_at is not null and not isfinite(p_expected_ended_at))
    or p_started_at is null or p_ended_at is null or not isfinite(p_started_at) or not isfinite(p_ended_at)
    or p_started_at<v_day.boundary_at or p_started_at>=v_day.cutoff_at or p_ended_at<p_started_at or p_ended_at>v_day.cutoff_at then
    raise exception 'Period outside work day' using errcode='22023';
  end if;
  if p_ended_at>v_now then raise exception 'Period ends in future' using errcode='22008'; end if;
  if (v_segment.started_at,v_segment.ended_at,v_segment.area_id,v_segment.task_id) is not distinct from (p_started_at,p_ended_at,p_area_id,p_task_id) then
    return public.flow_work_day_snapshot(p_work_day_id);
  end if;
  if (v_segment.started_at,v_segment.ended_at,v_segment.area_id,v_segment.task_id) is distinct from
    (p_expected_started_at,p_expected_ended_at,p_expected_area_id,p_expected_task_id) then
    raise exception 'Period changed; refresh before correcting' using errcode='40001';
  end if;
  -- Preserve the existing forgotten-timer close-only path; ordinary edits require Pause.
  if v_segment.ended_at is null and (p_started_at,p_area_id,p_task_id) is distinct from (v_segment.started_at,v_segment.area_id,v_segment.task_id) then
    raise exception 'Pause before correcting an open period' using errcode='22023';
  end if;
  begin
    update public.flow_work_segments set started_at=p_started_at,ended_at=p_ended_at,area_id=p_area_id,task_id=p_task_id
      where id=p_segment_id and user_id=v_user;
  exception when check_violation then
    if sqlerrm in ('Work segments overlap','Native work overlaps legacy history') then
      raise exception 'Corrected period overlaps work' using errcode='23P01';
    elsif sqlerrm in ('Segment area must match task area at attribution time','Task is completed') then
      raise exception 'Invalid period attribution' using errcode='23503';
    else raise; end if;
  end;
  return public.flow_work_day_snapshot(p_work_day_id);
end $$;
-- CREATE OR REPLACE retains the existing authenticated-only grants and RLS.
commit;
