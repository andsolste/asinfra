-- Native segment correction (#34C). No day edits, backfill, deletion or audit table.
begin;

create function public.flow_work_segment_correct(
  p_segment_id uuid, p_work_day_id uuid,
  p_expected_started_at timestamptz, p_expected_ended_at timestamptz,
  p_expected_area_id uuid, p_expected_task_id uuid,
  p_started_at timestamptz, p_ended_at timestamptz, p_area_id uuid, p_task_id uuid
) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_segment public.flow_work_segments; v_day public.flow_work_days; v_now timestamptz;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  -- Reconcile BEFORE comparing expected state. A formerly open segment that has
  -- crossed cutoff is now closed; expected NULL must not silently match it.
  perform public.flow_work_day_snapshot();
  select * into v_segment from public.flow_work_segments
    where id=p_segment_id and work_day_id=p_work_day_id and user_id=v_user for update;
  if not found then raise exception 'Work period unavailable' using errcode='42501'; end if;
  select * into v_day from public.flow_work_days where id=v_segment.work_day_id and user_id=v_user for update;
  v_now:=clock_timestamp();
  if p_expected_started_at is null or not isfinite(p_expected_started_at) or
    (p_expected_ended_at is not null and not isfinite(p_expected_ended_at)) or
    p_started_at is null or p_ended_at is null or not isfinite(p_started_at) or not isfinite(p_ended_at) or
    p_started_at < v_day.started_at or p_started_at >= v_day.cutoff_at or p_ended_at < p_started_at or
    p_ended_at > least(v_day.cutoff_at,coalesce(v_day.ended_at,v_day.cutoff_at)) then
    raise exception 'Period outside work day' using errcode='22023';
  end if;
  if p_ended_at > v_now then raise exception 'Period ends in future' using errcode='22008'; end if;
  -- Exact desired-state acknowledgement makes a repeated request safe after a
  -- lost response. It does NOT rebase expected state or write a newer segment.
  if (v_segment.started_at,v_segment.ended_at,v_segment.area_id,v_segment.task_id)
    is not distinct from (p_started_at,p_ended_at,p_area_id,p_task_id) then
    return public.flow_work_day_snapshot(p_work_day_id);
  end if;
  if (v_segment.started_at,v_segment.ended_at,v_segment.area_id,v_segment.task_id)
    is distinct from (p_expected_started_at,p_expected_ended_at,p_expected_area_id,p_expected_task_id) then
    raise exception 'Period changed; refresh before correcting' using errcode='40001';
  end if;
  begin
    update public.flow_work_segments set started_at=p_started_at,ended_at=p_ended_at,
      area_id=p_area_id,task_id=p_task_id where id=p_segment_id and user_id=v_user;
  exception when check_violation then
    -- Keep the canonical table triggers as the final defence. Only translate
    -- their known errors; never duplicate their overlap/attribution algorithms.
    if sqlerrm in ('Work segments overlap','Native work overlaps legacy history') then
      raise exception 'Corrected period overlaps work' using errcode='23P01';
    elsif sqlerrm in ('Segment area must match task area at attribution time','Task is completed') then
      raise exception 'Invalid period attribution' using errcode='23503';
    else raise; end if;
  end;
  -- Non-NULL end always closes an open segment. The day stays paused, not ended;
  -- no replacement segment is created. Existing closed days stay closed.
  return public.flow_work_day_snapshot(p_work_day_id);
end $$;

revoke all on function public.flow_work_segment_correct(uuid,uuid,timestamptz,timestamptz,uuid,uuid,timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.flow_work_segment_correct(uuid,uuid,timestamptz,timestamptz,uuid,uuid,timestamptz,timestamptz,uuid,uuid) to authenticated;
commit;
