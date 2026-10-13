-- Flow tasks. Recommended writes acquire the SAME user lock as the timer before
-- row locks. Table triggers enforce invariants for direct Data API writes too.
begin;
lock table public.flow_tasks, public.flow_work_days, public.flow_work_segments in share row exclusive mode;

-- Never guess a completion time for inconsistent pre-existing foundation data.
do $$ begin
  if exists (select 1 from public.flow_tasks t join public.flow_work_segments s
    on s.task_id=t.id and s.user_id=t.user_id where s.ended_at is null
      and (t.status='completed' or s.area_id is distinct from t.area_id)) then
    raise exception 'Review inconsistent tasks with open segments before task migration';
  end if;
end $$;
alter table public.flow_tasks add column updated_at timestamptz;
update public.flow_tasks set updated_at=coalesce(completed_at,created_at);
alter table public.flow_tasks alter column updated_at set not null;
alter table public.flow_tasks alter column updated_at set default clock_timestamp();
alter table public.flow_tasks add constraint flow_task_updated_finite check(isfinite(updated_at));
-- Existing flow_segments_owner_task already supports the task aggregate.

create function public.flow_guard_task() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_now timestamptz; v_open public.flow_work_segments;
begin
  if auth.uid() is not null and new.user_id<>auth.uid() then
    raise exception 'Ownership mismatch' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
  if tg_op='UPDATE' and (new.id,new.user_id,new.created_at) is distinct from (old.id,old.user_id,old.created_at) then
    raise exception 'Task identity and creation time are immutable' using errcode='23514';
  end if;
  if new.status is null or new.status not in ('active','completed') then
    raise exception 'Invalid task status' using errcode='23514';
  end if;
  new.title:=btrim(new.title);
  -- Only reconcile the authenticated owner's timer. No security-definer bypass.
  if auth.uid() is not null then perform public.flow_work_day_snapshot(); end if;
  v_now:=clock_timestamp();
  select * into v_open from public.flow_work_segments where user_id=new.user_id
    and task_id=new.id and ended_at is null for update;
  if tg_op='UPDATE' and new.area_id is distinct from old.area_id and v_open.id is not null then
    raise exception 'Pause before moving the active task' using errcode='23514';
  end if;
  if new.area_id is not null and (tg_op='INSERT' or new.area_id is distinct from old.area_id) then
    perform 1 from public.flow_areas where id=new.area_id and user_id=new.user_id and not is_archived for share;
    if not found then raise exception 'Area unavailable' using errcode='23503'; end if;
  end if;
  if tg_op='INSERT' then
    new.created_at:=v_now; new.updated_at:=v_now;
    new.completed_at:=case when new.status='completed' then v_now else null end;
  else
    if new.status='completed' and old.status='active' then
      if v_open.id is not null then
        if v_open.started_at>v_now then raise exception 'Review future-dated task work' using errcode='22023'; end if;
        update public.flow_work_segments set ended_at=least(v_now,(select cutoff_at from public.flow_work_days where id=v_open.work_day_id))
          where id=v_open.id and user_id=new.user_id;
        if auth.uid() is not null then perform public.flow_work_day_snapshot(); end if;
      end if;
      new.completed_at:=v_now;
    elsif new.status='active' then new.completed_at:=null;
    else new.completed_at:=old.completed_at;
    end if;
    new.updated_at:=case when (new.title,new.description,new.area_id,new.deadline_at,new.status)
      is distinct from (old.title,old.description,old.area_id,old.deadline_at,old.status)
      then greatest(v_now,old.updated_at+interval '1 microsecond') else old.updated_at end;
  end if;
  return new;
end $$;
create trigger flow_task_guard before insert or update on public.flow_tasks
for each row execute function public.flow_guard_task();

-- Recheck EVERY open write, not just changes to attribution. Closing historical
-- work remains possible after completion/move; its original area is never rewritten.
create function public.flow_guard_task_work() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.task_id is not null and new.ended_at is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9));
    perform 1 from public.flow_tasks where id=new.task_id and user_id=new.user_id
      and status='active' and area_id is not distinct from new.area_id for share;
    if not found then raise exception 'Task unavailable for open work' using errcode='23514'; end if;
  end if;
  return new;
end $$;
create trigger flow_task_work_guard before insert or update on public.flow_work_segments
for each row execute function public.flow_guard_task_work();

-- UUID on create is an idempotency token. Updating uses optimistic concurrency:
-- stale forms cannot silently overwrite another tab. Repeat creates never edit.
create function public.flow_task_save(p_task_id uuid,p_title text,p_description text,
  p_area_id uuid,p_deadline_at timestamptz,p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_task public.flow_tasks;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_task_id is null then raise exception 'Task ID required' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  select * into v_task from public.flow_tasks where id=p_task_id and user_id=v_user for update;
  if p_expected_updated_at is null then
    if not found then
      insert into public.flow_tasks(id,title,description,area_id,deadline_at)
        values(p_task_id,p_title,p_description,p_area_id,p_deadline_at) returning * into v_task;
    end if;
  else
    if not found then raise exception 'Task not found' using errcode='22023'; end if;
    if v_task.updated_at<>p_expected_updated_at then raise exception 'Task changed; refresh before editing' using errcode='40001'; end if;
    update public.flow_tasks set title=p_title,description=p_description,area_id=p_area_id,deadline_at=p_deadline_at
      where id=p_task_id and user_id=v_user returning * into v_task;
  end if;
  return to_jsonb(v_task);
end $$;

create function public.flow_task_status(p_task_id uuid,p_status text,p_expected_updated_at timestamptz) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_task public.flow_tasks;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('active','completed') then raise exception 'Invalid task status' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  perform public.flow_work_day_snapshot();
  select * into v_task from public.flow_tasks where id=p_task_id and user_id=v_user for update;
  if not found then raise exception 'Task not found' using errcode='22023'; end if;
  -- Retrying desired status is harmless; a stale complete after a reopen is not.
  if v_task.status<>p_status then
    if p_expected_updated_at is distinct from v_task.updated_at then
      raise exception 'Task changed; refresh before editing' using errcode='40001';
    end if;
    update public.flow_tasks set status=p_status where id=p_task_id and user_id=v_user returning * into v_task;
  end if;
  return to_jsonb(v_task);
end $$;

-- Only native task IDs, never legacy descriptions. Aggregate in the database;
-- no full history download, no client-supplied clock, no cross-user totals.
create function public.flow_task_time(p_task_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_now timestamptz; v_total numeric;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  perform public.flow_work_day_snapshot();
  if not exists(select 1 from public.flow_tasks where id=p_task_id and user_id=v_user) then
    raise exception 'Task not found' using errcode='22023';
  end if;
  v_now:=clock_timestamp();
  select coalesce(sum(greatest(0,extract(epoch from
    (least(coalesce(s.ended_at,v_now),d.cutoff_at,v_now)-s.started_at))*1000)),0) into v_total
    from public.flow_work_segments s join public.flow_work_days d on d.id=s.work_day_id and d.user_id=s.user_id
    where s.user_id=v_user and s.task_id=p_task_id;
  return jsonb_build_object('task_id',p_task_id,'work_milliseconds',v_total,'server_time',v_now);
end $$;

revoke all on function public.flow_guard_task(),public.flow_guard_task_work() from public,anon,authenticated;
revoke all on function public.flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz),
  public.flow_task_status(uuid,text,timestamptz),public.flow_task_time(uuid) from public,anon,authenticated;
grant execute on function public.flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz),
  public.flow_task_status(uuid,text,timestamptz),public.flow_task_time(uuid) to authenticated;
commit;
