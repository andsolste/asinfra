-- Weekly planning is metadata on existing tasks, not a second completion model.
begin;

alter table public.flow_tasks
  add column week_start date,
  add column priority text not null default 'normal',
  add constraint flow_task_week_monday check (week_start is null or
    (isfinite(week_start) and week_start between date '0001-01-01' and date '9999-12-31'
      and extract(isodow from week_start) = 1)),
  add constraint flow_task_priority check (priority in ('high','normal','low'));

create index flow_tasks_owner_week on public.flow_tasks(user_id,week_start)
  where week_start is not null;

-- Runs AFTER flow_task_guard (alphabetical trigger order). Keep the canonical
-- identity/status/timer guard intact, while versioning planning-only edits too.
create function public.flow_guard_task_planning() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if (new.week_start,new.priority) is distinct from (old.week_start,old.priority) then
    new.updated_at:=greatest(new.updated_at,old.updated_at+interval '1 microsecond',clock_timestamp());
  end if;
  return new;
end $$;
create trigger flow_task_planning_guard before update on public.flow_tasks
for each row execute function public.flow_guard_task_planning();
revoke all on function public.flow_guard_task_planning() from public,anon,authenticated;

-- Preserve the six-argument RPC for deployed clients. The eight-argument overload
-- has NO defaults: named PostgREST requests resolve unambiguously by argument set.
-- Reuse the canonical save, owner lock and stale revision check in one transaction.
create function public.flow_task_save(p_task_id uuid,p_title text,p_description text,
  p_area_id uuid,p_deadline_at timestamptz,p_expected_updated_at timestamptz,
  p_week_start date,p_priority text) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_user uuid:=auth.uid(); v_task public.flow_tasks;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,9));
  select * into v_task from public.flow_tasks where id=p_task_id and user_id=v_user for update;
  -- A repeated create is still an acknowledgement, never an edit of a newer task.
  if p_expected_updated_at is null and found then return to_jsonb(v_task); end if;
  perform public.flow_task_save(p_task_id,p_title,p_description,p_area_id,p_deadline_at,p_expected_updated_at);
  update public.flow_tasks set week_start=p_week_start,priority=p_priority
    where id=p_task_id and user_id=v_user returning * into v_task;
  return to_jsonb(v_task);
end $$;
revoke all on function public.flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz,date,text)
  from public,anon,authenticated;
grant execute on function public.flow_task_save(uuid,text,text,uuid,timestamptz,timestamptz,date,text)
  to authenticated;

commit;
