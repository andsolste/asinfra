-- Explicit local export. No work is copied, no file is stored, and no old RPC changes.
begin;
create schema if not exists flow_private;
revoke all on schema flow_private from public, anon;
grant usage on schema flow_private to authenticated;

-- Internal SQL helper, NOT in the Data API's exposed public schema. Period dates
-- come from flow_statistics; 04:00/DST boundaries come from flow_day_bounds.
create function flow_private.export_slices(p_period jsonb, p_reference timestamptz, p_timezone text)
returns table (sort_start timestamptz, source text, segment_id uuid, flow_date date, row_data jsonb)
language sql stable security invoker set search_path='' set timezone='UTC' as $$
  with dates as (
    select p_period->>'kind' as kind, (p_period->>'from_date')::date as first_date,
      (p_period->>'to_date')::date as last_date
  ), bounds as (
    select d.*,case when first_date is not null then (select boundary_at from public.flow_day_bounds((first_date+time '12:00') at time zone p_timezone,p_timezone)) end as first_at,
      case when last_date is not null then (select boundary_at from public.flow_day_bounds((last_date+time '12:00') at time zone p_timezone,p_timezone)) end as last_at
    from dates d
  ), raw as materialized (
    select r.*, least(coalesce(r.ended_at,p_reference),coalesce(r.cutoff_at,p_reference),p_reference) as stop
    from public.flow_read_segments r cross join bounds b
    where r.started_at<p_reference and (b.kind='total'
      or r.source='flow' and r.logical_date>=b.first_date and r.logical_date<b.last_date
      or r.source='legacy-study'
        and r.started_at<b.last_at and coalesce(r.ended_at,r.cutoff_at,p_reference)>b.first_at)
  ), legacy as materialized (
    select r.*,greatest(r.started_at,coalesce(b.first_at,r.started_at)) as slice_start,
      least(r.stop,coalesce(b.last_at,r.stop)) as slice_end
    from raw r cross join bounds b where r.source='legacy-study' and r.stop>r.started_at
  ), candidate_dates as materialized (
    -- Cache boundaries by date, not by row: thousands of segments on one date
    -- must not repeatedly enumerate/validate the timezone catalogue.
    select distinct (r.slice_start at time zone p_timezone)::date-1+i as date
    from legacy r cross join lateral generate_series(0,
      (r.slice_end at time zone p_timezone)::date-(r.slice_start at time zone p_timezone)::date+1) i
    where r.slice_end>r.slice_start
  ), calendar as materialized (
    select d.* from candidate_dates c
    cross join lateral public.flow_day_bounds((c.date+time '12:00') at time zone p_timezone,p_timezone) d
    where d.logical_date=c.date
  ), slices as (
    select r.source,r.segment_id,r.record_id,r.area_id,r.task_id,r.logical_date as flow_date,
      r.started_at as slice_start,r.stop as slice_end,d.timezone
    from raw r join public.flow_work_days d on r.source='flow' and d.id=r.record_id and d.user_id=auth.uid()
    where r.stop>r.started_at
    union all
    select r.source,r.segment_id,r.record_id,r.area_id,null::uuid,d.logical_date,
      greatest(r.slice_start,d.boundary_at),least(r.slice_end,d.cutoff_at),p_timezone
    from legacy r join calendar d on r.slice_start<d.cutoff_at and r.slice_end>d.boundary_at
    where r.slice_end>r.slice_start
  )
  select s.slice_start,s.source,s.segment_id,s.flow_date,jsonb_build_object(
    'source',s.source,'segment_id',s.segment_id,'flow_date',s.flow_date,'timezone',s.timezone,
    'started_at',s.slice_start,'ended_at',s.slice_end,
    'work_microseconds',(extract(epoch from(s.slice_end-s.slice_start))*1000000)::bigint::text,
    'area_id',s.area_id,'area_name',coalesce(a.name,case when s.area_id is null then 'Annet' else 'Utilgjengelig område' end),
    'area_code',a.code,'area_archived',coalesce(a.is_archived,false),
    'task_id',s.task_id,'task_title',t.title,'task_status',t.status,'task_deadline',t.deadline_at,
    'description',case when s.source='legacy-study' then coalesce(h.description,'') else coalesce(t.description,'') end)
  from slices s
  left join public.flow_areas a on a.id=s.area_id and a.user_id=auth.uid()
  left join public.flow_tasks t on t.id=s.task_id and t.user_id=auth.uid()
  left join public.study_sessions h on s.source='legacy-study' and h.id=s.record_id and h.user_id=auth.uid()
  where s.slice_end>s.slice_start;
$$;
revoke all on function flow_private.export_slices(jsonb,timestamptz,text) from public,anon,authenticated;
grant execute on function flow_private.export_slices(jsonb,timestamptz,text) to authenticated;

-- A small immutable manifest, not a stored CSV/raw-data snapshot. It fixes the
-- server reference/period and fingerprints canonical slices + current metadata.
-- Later corrections/deletions/metadata changes invalidate the job, never silently
-- mix versions. Normal timer growth beyond reference produces identical slices.
create table public.flow_export_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  requested_kind text not null default 'week', requested_date date, display_timezone text,
  period jsonb not null default '{}', reference_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp(), fingerprint text not null default '',
  total_rows bigint not null default 0, total_microseconds numeric not null default 0,
  statistics jsonb not null default '{}'
);
create index flow_export_jobs_owner_expiry on public.flow_export_jobs(user_id,expires_at);
alter table public.flow_export_jobs enable row level security;
revoke all on public.flow_export_jobs from public,anon,authenticated;
grant select,insert,delete on public.flow_export_jobs to authenticated;
create policy own_read on public.flow_export_jobs for select to authenticated using (user_id=(select auth.uid()));
create policy own_insert on public.flow_export_jobs for insert to authenticated with check (user_id=(select auth.uid()));
create policy own_delete on public.flow_export_jobs for delete to authenticated using (user_id=(select auth.uid()));

create function flow_private.export_manifest() returns trigger
language plpgsql security invoker set search_path='' set timezone='UTC' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if new.display_timezone is null or not (new.display_timezone='UTC' or position('/' in new.display_timezone)>0)
    or not exists(select 1 from pg_catalog.pg_timezone_names where name=new.display_timezone) then
    raise exception 'Valid display timezone required for CSV logical dates' using errcode='22023'; end if;
  -- Direct inserts cannot forge owner, time, period, summary, digest or job token.
  new.id:=gen_random_uuid(); new.user_id:=auth.uid(); new.reference_at:=statement_timestamp();
  new.expires_at:=new.reference_at+interval '30 minutes';
  new.statistics:=public.flow_statistics(new.requested_kind,new.requested_date,new.display_timezone);
  if new.statistics->>'legacy_timezone_error' is not null then
    raise exception 'Unrepresentable export timezone boundary' using errcode='22023'; end if;
  new.period:=new.statistics->'period';
  select md5(coalesce(jsonb_agg(s.row_data order by s.sort_start,s.source,s.segment_id,s.flow_date),'[]')::text),
    count(*),coalesce(sum((s.row_data->>'work_microseconds')::numeric),0)
    into new.fingerprint,new.total_rows,new.total_microseconds
    from flow_private.export_slices(new.period,new.reference_at,new.display_timezone) s;
  if abs(new.total_microseconds/1000-(new.statistics->>'total')::numeric)>.001 then
    raise exception 'Export/statistics mismatch; no partial export' using errcode='40001'; end if;
  return new;
end $$;
revoke all on function flow_private.export_manifest() from public,anon,authenticated;
create trigger flow_export_manifest before insert on public.flow_export_jobs
  for each row execute function flow_private.export_manifest();

create function public.flow_export_rows(p_cursor jsonb,p_limit integer default 500) returns jsonb
language plpgsql stable security invoker set search_path='' set timezone='UTC' as $$
declare v_job public.flow_export_jobs; v_id uuid; v_after bigint; v_hash text; v_count bigint; v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 1000 or p_cursor is null or jsonb_typeof(p_cursor)<>'object'
    or (select count(*) from jsonb_object_keys(p_cursor))<>2
    or jsonb_typeof(p_cursor->'job') is distinct from 'string'
    or jsonb_typeof(p_cursor->'after') is distinct from 'number'
    or (p_cursor->>'after') !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Invalid export cursor/limit' using errcode='22023'; end if;
  v_id:=(p_cursor->>'job')::uuid; v_after:=(p_cursor->>'after')::bigint;
  select * into v_job from public.flow_export_jobs where id=v_id and user_id=auth.uid() and expires_at>statement_timestamp();
  if not found then raise exception 'Export unavailable or expired; restart' using errcode='42501'; end if;
  if v_after>v_job.total_rows then raise exception 'Invalid export position' using errcode='22023'; end if;
  -- One MVCC statement snapshot for the full digest AND the requested page.
  with slices as materialized (select * from flow_private.export_slices(v_job.period,v_job.reference_at,v_job.display_timezone)),
  ordered as (select row_number() over(order by sort_start,source,segment_id,flow_date) as ordinal,row_data from slices)
  select md5(coalesce(jsonb_agg(s.row_data order by s.sort_start,s.source,s.segment_id,s.flow_date),'[]')::text),count(*),
    coalesce((select jsonb_agg(o.row_data||jsonb_build_object('ordinal',o.ordinal) order by o.ordinal)
      from ordered o where o.ordinal>v_after and o.ordinal<=v_after+p_limit),'[]')
    into v_hash,v_count,v_rows from slices s;
  if v_hash<>v_job.fingerprint or v_count<>v_job.total_rows then
    raise exception 'Export data changed; restart' using errcode='40001'; end if;
  return jsonb_build_object('job_id',v_job.id,'period',v_job.period,'server_time',v_job.reference_at,
    'expires_at',v_job.expires_at,'total_rows',v_job.total_rows,'rows',v_rows,
    'next_cursor',case when v_after+jsonb_array_length(v_rows)<v_job.total_rows then
      jsonb_build_object('job',v_job.id,'after',v_after+jsonb_array_length(v_rows)) else null end);
end $$;

create function public.flow_export_start(p_kind text default 'week',p_date date default null,p_timezone text default null) returns jsonb
language plpgsql volatile security invoker set search_path='' set timezone='UTC' as $$
declare v_job public.flow_export_jobs;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  delete from public.flow_export_jobs where user_id=auth.uid() and expires_at<=statement_timestamp();
  insert into public.flow_export_jobs(requested_kind,requested_date,display_timezone) values(p_kind,p_date,p_timezone) returning * into v_job;
  return public.flow_export_rows(jsonb_build_object('job',v_job.id,'after',0))||jsonb_build_object('statistics',v_job.statistics);
end $$;

create function public.flow_export_discard(p_job_id uuid) returns void
language plpgsql volatile security invoker set search_path='' set timezone='UTC' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  delete from public.flow_export_jobs where id=p_job_id and user_id=auth.uid();
end;
$$;
revoke all on function public.flow_export_start(text,date,text),public.flow_export_rows(jsonb,integer),public.flow_export_discard(uuid) from public,anon,authenticated;
grant execute on function public.flow_export_start(text,date,text),public.flow_export_rows(jsonb,integer),public.flow_export_discard(uuid) to authenticated;
commit;
