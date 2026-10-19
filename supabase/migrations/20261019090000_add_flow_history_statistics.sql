-- Unified reads keep both physical sources. No backfill and no timer contract changes.
begin;
create index flow_history_owner_started on public.flow_work_days(user_id, started_at desc, id desc);
create index study_history_owner_started on public.study_sessions(user_id, started_at desc, id desc) where ended_at is not null;

-- Invoker view: table grants AND RLS apply to the caller. A source/segment ID
-- occurs exactly once. Area attribution always comes from the recorded segment.
create view public.flow_read_segments with (security_invoker=true) as
  select 'flow'::text as source, s.id as segment_id, s.work_day_id as record_id,
    d.logical_date, s.area_id, s.task_id, s.started_at, s.ended_at, d.cutoff_at
  from public.flow_work_segments s join public.flow_work_days d on d.id=s.work_day_id and d.user_id=s.user_id
  where s.user_id=auth.uid()
  union all
  select 'legacy-study', s.id, s.session_id, null::date, h.subject_id, null::uuid,
    s.started_at, s.ended_at, least(h.ended_at,c.activated_at)
  from public.study_session_segments s join public.study_sessions h on h.id=s.session_id and h.user_id=s.user_id
    left join public.flow_timer_cutovers c on c.user_id=s.user_id
  where s.user_id=auth.uid() and isfinite(s.started_at) and (s.ended_at is null or isfinite(s.ended_at));
revoke all on public.flow_read_segments from public,anon,authenticated;
grant select on public.flow_read_segments to authenticated;

-- One ordered UNION, not two independently truncated pages. Cursor uses the
-- original microsecond timestamp + source + UUID, never a JS-rounded timestamp.
create function public.flow_history(p_limit integer default 25,p_cursor jsonb default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_now timestamptz:=statement_timestamp(); v_at timestamptz; v_source text; v_id uuid; v_rows jsonb; v_next jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1..100' using errcode='22023'; end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor)<>'object' or jsonb_typeof(p_cursor->'at') is distinct from 'string'
      or jsonb_typeof(p_cursor->'id') is distinct from 'string' or p_cursor->>'source' not in ('flow','legacy-study')
      or p_cursor->>'source' is null then raise exception 'Invalid history cursor' using errcode='22023'; end if;
    v_at:=(p_cursor->>'at')::timestamptz; v_source:=p_cursor->>'source'; v_id:=(p_cursor->>'id')::uuid;
    if not isfinite(v_at) then raise exception 'Finite cursor required' using errcode='22023'; end if;
  end if;
  with candidates as (
    select 'flow'::text as source,id,started_at from public.flow_work_days
      where user_id=auth.uid() and (ended_at is not null or cutoff_at<=v_now)
    union all
    select 'legacy-study',id,started_at from public.study_sessions
      where user_id=auth.uid() and ended_at is not null and isfinite(started_at) and isfinite(ended_at)
  ), page as materialized (
    select * from candidates where p_cursor is null or (started_at,source,id)<(v_at,v_source,v_id)
      order by started_at desc,source desc,id desc limit p_limit+1
  ), visible as (select * from page order by started_at desc,source desc,id desc limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('source',p.source,'id',p.id,'started_at',p.started_at,
    'snapshot',case when p.source='flow' then (
      select jsonb_build_object('work_day',to_jsonb(d)-'user_id','server_time',v_now,
        'segments',coalesce((select jsonb_agg(to_jsonb(s)-'user_id' order by s.started_at,s.id)
          from public.flow_work_segments s where s.work_day_id=d.id and s.user_id=auth.uid()),'[]'::jsonb))
      from public.flow_work_days d where d.id=p.id and d.user_id=auth.uid())
    else (select jsonb_build_object('session',jsonb_build_object('id',h.id,'subject_id',h.subject_id,'description',h.description,
      'started_at',h.started_at,'ended_at',h.ended_at),
      'subject',(select to_jsonb(a)-'user_id' from public.flow_areas a where a.id=h.subject_id and a.user_id=auth.uid()),
      'segments',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'session_id',s.session_id,
        'started_at',s.started_at,'ended_at',s.ended_at) order by s.started_at,s.id)
        from public.study_session_segments s where s.session_id=h.id and s.user_id=auth.uid()),'[]'::jsonb))
      from public.study_sessions h where h.id=p.id and h.user_id=auth.uid()) end)
    order by p.started_at desc,p.source desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from page)>p_limit then (select jsonb_build_object('at',started_at,'source',source,'id',id)
      from visible order by started_at,source,id limit 1) else null end
    into v_rows,v_next from visible p;
  return jsonb_build_object('rows',v_rows,'next_cursor',v_next,'server_time',v_now);
end $$;

-- One statement snapshot and one SERVER statement clock across all aggregates.
-- No long advisory lock: MVCC sees either side of an atomic transition, never half.
create function public.flow_statistics(p_kind text default 'week',p_date date default null,p_timezone text default null,
  p_area_id uuid default null,p_area_only boolean default false,p_task_id uuid default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_now timestamptz:=statement_timestamp(); v_anchor date; v_from date; v_to date;
  v_zone text; v_error text; v_result jsonb; v_task_date date;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('day','week','month','total') or p_area_only is null or
    (p_date is not null and (not isfinite(p_date) or p_date<'0001-01-01'::date or p_date>'9998-12-31'::date)) then
    raise exception 'Invalid logical period' using errcode='22023'; end if;
  if p_area_only and p_area_id is not null and not exists(select 1 from public.flow_areas where id=p_area_id and user_id=auth.uid()) then
    raise exception 'Area not found' using errcode='22023'; end if;
  if p_task_id is not null and not exists(select 1 from public.flow_tasks where id=p_task_id and user_id=auth.uid()) then
    raise exception 'Task not found' using errcode='22023'; end if;
  if (p_timezone='UTC' or position('/' in p_timezone)>0) and exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then
    v_zone:=p_timezone;
  else v_error:='invalid-timezone'; end if;
  select logical_date into v_task_date from public.flow_work_days where user_id=auth.uid()
    and boundary_at<=v_now and cutoff_at>v_now order by started_at desc limit 1;
  if p_kind<>'total' then
    v_anchor:=coalesce(p_date,v_task_date);
    if v_anchor is null and v_zone is not null then
      begin select logical_date into v_anchor from public.flow_day_bounds(v_now,v_zone);
      exception when invalid_parameter_value then v_error:='unrepresentable-boundary'; end;
    end if;
    -- Never label a past native day as "today" merely because its date is known.
    -- An explicit date or a current frozen day still works without a display zone.
    if v_anchor is null then raise exception 'Choose a logical date or valid display timezone' using errcode='22023'; end if;
    v_from:=case p_kind when 'day' then v_anchor when 'week' then v_anchor-(extract(isodow from v_anchor)::integer-1)
      else date_trunc('month',v_anchor)::date end;
    v_to:=case p_kind when 'day' then v_from+1 when 'week' then v_from+7 else (v_from+interval '1 month')::date end;
    if v_zone is not null and exists(select 1 from generate_series(0,v_to-v_from) i
      where (((v_from+i)+time '04:00') at time zone v_zone) at time zone v_zone <> (v_from+i)+time '04:00') then
      v_error:='unrepresentable-boundary';
    end if;
  end if;
  with raw as materialized (
    select r.*,least(coalesce(r.ended_at,v_now),coalesce(r.cutoff_at,v_now),v_now) as stop
    from public.flow_read_segments r
    where (not p_area_only or r.area_id is not distinct from p_area_id)
      and (p_task_id is null or (r.source='flow' and r.task_id=p_task_id)) and r.started_at<v_now
      and (p_kind='total' or r.source='flow' and r.logical_date>=v_from and r.logical_date<v_to
        or r.source='legacy-study' and v_error is null
          and r.started_at<((v_to+time '04:00') at time zone v_zone)
          and coalesce(r.ended_at,r.cutoff_at,v_now)>((v_from+time '04:00') at time zone v_zone))
  ), calendar as materialized (
    select v_from+i as date,((v_from+i)+time '04:00') at time zone v_zone as start,
      ((v_from+i+1)+time '04:00') at time zone v_zone as stop
    from generate_series(0,coalesce(v_to-v_from,0)-1) i where v_error is null
  ), contributions as materialized (
    select logical_date as date,area_id,task_id,source,extract(epoch from(stop-started_at))*1000 as work
      from raw where source='flow' and stop>started_at and (p_kind='total' or logical_date>=v_from and logical_date<v_to)
    union all
    select null::date,area_id,null::uuid,source,extract(epoch from(stop-started_at))*1000
      from raw where source='legacy-study' and stop>started_at and p_kind='total'
    union all
    select c.date,r.area_id,null::uuid,r.source,extract(epoch from(least(r.stop,c.stop)-greatest(r.started_at,c.start)))*1000
      from raw r join calendar c on r.started_at<c.stop and r.stop>c.start
      where r.source='legacy-study' and r.stop>r.started_at
  ), area_totals as (
    select area_id,sum(work) as work from contributions group by area_id
  ), area_rows as (
    select t.area_id as id,coalesce(a.name,case when t.area_id is null then 'Annet' else 'Utilgjengelig område' end) as name,
      a.code,coalesce(a.is_archived,false) as is_archived,t.work
    from area_totals t left join public.flow_areas a on a.id=t.area_id and a.user_id=auth.uid()
  ), day_area as (
    select date,area_id,sum(work) as work from contributions where date is not null and p_kind<>'total' group by date,area_id
  ), days as (
    select v_from+i as date from generate_series(0,coalesce(v_to-v_from,0)-1) i
  ), tasks as (
    select c.area_id,c.task_id,c.source,sum(c.work) as work from contributions c group by c.area_id,c.task_id,c.source
  ) select jsonb_build_object('period',jsonb_build_object('kind',p_kind,'anchor',v_anchor,'from_date',v_from,'to_date',v_to,'timezone',v_zone),
    'server_time',v_now,'legacy_timezone_error',case when p_kind='total' then null else v_error end,
    'total',coalesce((select sum(work) from contributions),0),
    'areas',coalesce((select jsonb_agg(to_jsonb(a) order by a.work desc,a.name,a.id nulls last) from area_rows a),'[]'::jsonb),
    'days',coalesce((select jsonb_agg(jsonb_build_object('date',d.date,'total',coalesce((select sum(work) from day_area where date=d.date),0),
      'areas',coalesce((select jsonb_agg(jsonb_build_object('id',a.area_id,'work',a.work) order by a.area_id nulls last)
        from day_area a where a.date=d.date),'[]'::jsonb)) order by d.date) from days d),'[]'::jsonb),
    'contributions',coalesce((select jsonb_agg(jsonb_build_object('area_id',c.area_id,'task_id',c.task_id,'source',c.source,
      'title',t.title,'status',t.status,'work',c.work) order by c.work desc,c.area_id,c.task_id,c.source)
      from tasks c left join public.flow_tasks t on t.id=c.task_id and t.user_id=auth.uid()),'[]'::jsonb),
    'task_date',v_task_date,'task_today',case when p_task_id is null then null else coalesce((select sum(extract(epoch from(stop-started_at))*1000)
      from raw where source='flow' and logical_date=v_task_date and stop>started_at),0) end,
    'task_current',case when p_task_id is null then null else coalesce((select sum(extract(epoch from(stop-started_at))*1000)
      from raw where source='flow' and ended_at is null and logical_date=v_task_date and stop>started_at),0) end)
    into v_result;
  return v_result;
end $$;

-- All four calls share one statement clock/MVCC snapshot. Includes NULL=Annet.
create function public.flow_area_statistics(p_area_id uuid default null,p_timezone text default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb; v_kind text; v_period jsonb;
begin
  -- Auth/ownership checks run before catching a missing display-zone boundary.
  v_result:=jsonb_build_object('total',public.flow_statistics('total',null,p_timezone,p_area_id,true));
  foreach v_kind in array array['day','week','month'] loop
    begin v_period:=public.flow_statistics(v_kind,null,p_timezone,p_area_id,true);
    exception when invalid_parameter_value then v_period:=null; end;
    v_result:=v_result||jsonb_build_object(v_kind,v_period);
  end loop;
  return v_result;
end;
$$;

-- Native correction surface deliberately changes attribution ONLY. No timing or
-- day identity changes; existing segment guards validate own area/task and overlap.
create function public.flow_history_attribute(p_segment_id uuid,p_area_id uuid,p_task_id uuid,
  p_expected_area_id uuid,p_expected_task_id uuid) returns uuid
language plpgsql volatile security invoker set search_path='' as $$
declare v_segment public.flow_work_segments;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,9));
  perform public.flow_work_day_snapshot();
  select s.* into v_segment from public.flow_work_segments s join public.flow_work_days d on d.id=s.work_day_id and d.user_id=s.user_id
    where s.id=p_segment_id and s.user_id=auth.uid() and s.ended_at is not null and d.ended_at is not null for update of s;
  if not found then raise exception 'Finished work required' using errcode='22023'; end if;
  if (v_segment.area_id,v_segment.task_id) is not distinct from (p_area_id,p_task_id) then return v_segment.id; end if;
  if (v_segment.area_id,v_segment.task_id) is distinct from (p_expected_area_id,p_expected_task_id) then
    raise exception 'Attribution changed; refresh before editing' using errcode='40001'; end if;
  update public.flow_work_segments set area_id=p_area_id,task_id=p_task_id where id=p_segment_id and user_id=auth.uid();
  return p_segment_id;
end $$;

-- Preserve the existing legacy editor/precision, while the unified UI additionally
-- rejects cross-record overlap. Failure rolls back the original RPC atomically.
create function public.flow_history_edit_legacy(p_session_id uuid,p_subject_id uuid,p_description text,
  p_started_at timestamptz,p_ended_at timestamptz,p_segments jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,9));
  v_result:=public.study_session_history_edit(p_session_id,p_subject_id,p_description,p_started_at,p_ended_at,p_segments);
  if exists(select 1 from public.study_session_segments own join public.flow_read_segments other
    on own.started_at<coalesce(other.ended_at,other.cutoff_at,'infinity'::timestamptz) and own.ended_at>other.started_at
    where own.session_id=p_session_id and own.user_id=auth.uid() and own.ended_at>own.started_at
      and (other.source<>'legacy-study' or other.record_id<>p_session_id)
      and (other.ended_at is null or other.ended_at>other.started_at)) then
    raise exception 'Corrected work overlaps another record' using errcode='22023';
  end if;
  return v_result;
end $$;

revoke all on function public.flow_history(integer,jsonb),public.flow_statistics(text,date,text,uuid,boolean,uuid),
  public.flow_area_statistics(uuid,text),public.flow_history_attribute(uuid,uuid,uuid,uuid,uuid),
  public.flow_history_edit_legacy(uuid,uuid,text,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.flow_history(integer,jsonb),public.flow_statistics(text,date,text,uuid,boolean,uuid),
  public.flow_area_statistics(uuid,text),public.flow_history_attribute(uuid,uuid,uuid,uuid,uuid),
  public.flow_history_edit_legacy(uuid,uuid,text,timestamptz,timestamptz,jsonb) to authenticated;
commit;
