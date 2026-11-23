-- Isolated exam module. Content is imported separately into the private schema.
begin;
create schema exam_private;
revoke all on schema exam_private from public,anon,authenticated;

create table exam_private.exams (
  exam_id text not null, version integer not null check(version>0),
  title text not null, course text not null, source_name text not null,
  source_sha256 text not null, package_sha256 text not null,
  introduction text not null default '', duration_minutes integer,
  primary key(exam_id,version)
);
create table exam_private.access (
  exam_id text not null, version integer not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(exam_id,version,user_id),
  foreign key(exam_id,version) references exam_private.exams
);
create table exam_private.questions (
  exam_id text not null, version integer not null, number integer not null check(number>0),
  title text not null, kind text not null check(kind in ('notes','single','multiple','text','matching','fill','visual','mixed')),
  max_points numeric not null check(max_points>=0), source_pages integer[] not null,
  prompt jsonb not null, review_status text not null check(review_status in ('verified','manual')),
  review_note text not null default '', grading text not null check(grading in ('automatic','self','unverified')),
  primary key(exam_id,version,number), foreign key(exam_id,version) references exam_private.exams
);
create table exam_private.keys (
  exam_id text not null, version integer not null, number integer not null,
  correct jsonb not null default '{}', guide_assets text[] not null default '{}',
  primary key(exam_id,version,number),
  foreign key(exam_id,version,number) references exam_private.questions
);
create table exam_private.assets (
  exam_id text not null, version integer not null, asset_id text not null, number integer not null,
  purpose text not null check(purpose in ('prompt','guide')),
  content_base64 text not null check(length(content_base64)<=4000000),
  primary key(exam_id,version,asset_id),
  foreign key(exam_id,version,number) references exam_private.questions
);
revoke all on all tables in schema exam_private from public,anon,authenticated;

create table public.exam_attempts (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  exam_id text not null, version integer not null,
  feedback text not null check(feedback in ('each','end')),
  mode text not null check(mode in ('practice','exam')),
  show_clock boolean not null default false,
  started_at timestamptz not null default clock_timestamp(),
  submitted_at timestamptz, revision integer not null default 0,
  current_question integer not null default 2,
  unique(id,user_id), foreign key(exam_id,version) references exam_private.exams,
  check(submitted_at is null or submitted_at>=started_at),
  check(mode='exam' or not show_clock)
);
create table public.exam_responses (
  attempt_id uuid not null, user_id uuid not null,
  number integer not null, answer jsonb not null default '{}',
  revision integer not null default 0, submitted_at timestamptz,
  auto_points numeric, self_assessment text check(self_assessment in ('full','partial','none')),
  last_request uuid, last_operation jsonb,
  primary key(attempt_id,number),
  foreign key(attempt_id,user_id) references public.exam_attempts(id,user_id) on delete cascade
);
alter table public.exam_attempts enable row level security;
alter table public.exam_responses enable row level security;
revoke all on public.exam_attempts,public.exam_responses from public,anon,authenticated;
grant select on public.exam_attempts,public.exam_responses to authenticated;
create policy own_attempts on public.exam_attempts for select to authenticated using ((select auth.uid())=user_id);
create policy own_responses on public.exam_responses for select to authenticated using ((select auth.uid())=user_id);
create index exam_attempts_owner on public.exam_attempts(user_id,started_at desc);

create function exam_private.authorize(p_attempt uuid) returns public.exam_attempts
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into a from public.exam_attempts where id=p_attempt and user_id=auth.uid();
  if not found or not exists(select 1 from exam_private.access where exam_id=a.exam_id and version=a.version and user_id=auth.uid()) then
    raise exception 'Attempt unavailable' using errcode='42501';
  end if;
  return a;
end $$;

create function exam_private.validate_answer(p_prompt jsonb,p_answer jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare f jsonb; v_answer jsonb; option_value jsonb; answer_key text;
begin
  if p_answer is null or jsonb_typeof(p_answer)<>'object' or octet_length(p_answer::text)>250000 then
    raise exception 'Invalid answer' using errcode='22023';
  end if;
  for answer_key in select jsonb_object_keys(p_answer) loop
    if not exists(select 1 from jsonb_array_elements(p_prompt->'fields') item where item->>'id'=answer_key) then
      raise exception 'Unknown answer field' using errcode='22023';
    end if;
  end loop;
  for f in select * from jsonb_array_elements(p_prompt->'fields') loop
    v_answer:=p_answer->(f->>'id');
    if v_answer is null then continue; end if;
    if f->>'kind'='text' then
      if jsonb_typeof(v_answer)<>'string' or length(v_answer#>>'{}')>50000 then raise exception 'Invalid text' using errcode='22023'; end if;
    elsif f->>'kind'='multiple' then
      if jsonb_typeof(v_answer)<>'array' or jsonb_array_length(v_answer)>(select jsonb_array_length(f->'options'))
        or (select count(*) from jsonb_array_elements(v_answer))<>(select count(distinct x) from jsonb_array_elements(v_answer) x) then
        raise exception 'Invalid selections' using errcode='22023';
      end if;
      for option_value in select * from jsonb_array_elements(v_answer) loop
        if not exists(select 1 from jsonb_array_elements(f->'options') o where o->'id'=option_value) then
          raise exception 'Unknown selection' using errcode='22023';
        end if;
      end loop;
    else
      if jsonb_typeof(v_answer)<>'string' or (v_answer<>'""'::jsonb and not exists(select 1 from jsonb_array_elements(f->'options') o where o->'id'=v_answer)) then
        raise exception 'Unknown selection' using errcode='22023';
      end if;
    end if;
  end loop;
end $$;

-- Simplified practice scoring: full original points for an exact complete set
-- of correct fields; otherwise zero. No official partial/negative formula is claimed.
create function exam_private.grade(p_exam text,p_version integer,p_number integer,p_answer jsonb) returns numeric
language plpgsql stable set search_path='' as $$
declare q exam_private.questions; k exam_private.keys; f jsonb; actual jsonb; expected jsonb;
begin
  select * into q from exam_private.questions where exam_id=p_exam and version=p_version and number=p_number;
  if q.grading<>'automatic' or q.review_status<>'verified' then return null; end if;
  select * into k from exam_private.keys where exam_id=p_exam and version=p_version and number=p_number;
  if k.correct='{}' then return null; end if;
  for f in select * from jsonb_array_elements(q.prompt->'fields') loop
    actual:=p_answer->(f->>'id'); expected:=k.correct->(f->>'id');
    if actual is null or expected is null then return 0; end if;
    if f->>'kind'='multiple' then
      if (select jsonb_agg(x order by x) from jsonb_array_elements(actual) x)
        is distinct from (select jsonb_agg(x order by x) from jsonb_array_elements(expected) x) then return 0; end if;
    elsif actual is distinct from expected then return 0;
    end if;
  end loop;
  return q.max_points;
end $$;

create function public.exam_catalogue() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return jsonb_build_object(
    'exams',coalesce((select jsonb_agg(jsonb_build_object('exam_id',e.exam_id,'version',e.version,'title',e.title,'course',e.course,
      'duration_minutes',e.duration_minutes,'question_count',(select count(*) from exam_private.questions q where q.exam_id=e.exam_id and q.version=e.version and max_points>0),
      'max_points',(select sum(max_points) from exam_private.questions q where q.exam_id=e.exam_id and q.version=e.version)) order by e.exam_id,e.version desc)
      from exam_private.exams e join exam_private.access a using(exam_id,version) where a.user_id=auth.uid()),'[]'::jsonb),
    'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by started_at desc) from public.exam_attempts a where user_id=auth.uid()),'[]'::jsonb),
    'server_time',clock_timestamp());
end $$;

create function public.exam_attempt_get(p_attempt_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts;
begin
  a:=exam_private.authorize(p_attempt_id);
  return jsonb_build_object(
    'attempt',to_jsonb(a),'server_time',clock_timestamp(),
    'exam',(select jsonb_build_object('title',title,'course',course,'source_name',source_name,'source_sha256',source_sha256,
      'introduction',introduction,'duration_minutes',duration_minutes) from exam_private.exams where exam_id=a.exam_id and version=a.version),
    'questions',(select jsonb_agg(to_jsonb(q) order by number) from exam_private.questions q where exam_id=a.exam_id and version=a.version),
    'responses',coalesce((select jsonb_agg(to_jsonb(r)-'last_operation' order by number) from public.exam_responses r where attempt_id=a.id),'[]'::jsonb));
end $$;

create function public.exam_attempt_start(p_attempt_id uuid,p_exam_id text,p_version integer,p_feedback text,p_mode text,p_show_clock boolean) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.exam_attempts;
begin
  if auth.uid() is null or not exists(select 1 from exam_private.access where exam_id=p_exam_id and version=p_version and user_id=auth.uid()) then
    raise exception 'Exam unavailable' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_attempt_id::text,26));
  select * into a from public.exam_attempts where id=p_attempt_id;
  if found then
    if (a.user_id,a.exam_id,a.version,a.feedback,a.mode,a.show_clock) is distinct from (auth.uid(),p_exam_id,p_version,p_feedback,p_mode,p_show_clock) then
      raise exception 'Attempt identity conflict' using errcode='40001';
    end if;
  else
    insert into public.exam_attempts(id,user_id,exam_id,version,feedback,mode,show_clock,current_question)
      values(p_attempt_id,auth.uid(),p_exam_id,p_version,p_feedback,p_mode,p_show_clock,
        (select coalesce(min(number) filter(where max_points>0),min(number)) from exam_private.questions where exam_id=p_exam_id and version=p_version));
  end if;
  return public.exam_attempt_get(p_attempt_id);
end $$;

create function public.exam_response_save(p_attempt_id uuid,p_number integer,p_expected_revision integer,p_answer jsonb,p_submit boolean,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.exam_attempts; r public.exam_responses; q exam_private.questions; operation jsonb; v_revision integer;
begin
  a:=exam_private.authorize(p_attempt_id);
  select * into a from public.exam_attempts where id=a.id for update;
  select * into q from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number;
  if not found or p_request_id is null or p_submit is null then raise exception 'Invalid response' using errcode='22023'; end if;
  operation:=jsonb_build_object('answer',p_answer,'submit',p_submit);
  select * into r from public.exam_responses where attempt_id=a.id and number=p_number;
  if r.last_request=p_request_id then
    if r.last_operation is distinct from operation then raise exception 'Retry conflict' using errcode='40001'; end if;
    return public.exam_attempt_get(a.id);
  end if;
  if a.submitted_at is not null or r.submitted_at is not null then raise exception 'Answer locked' using errcode='22023'; end if;
  if p_expected_revision is distinct from coalesce(r.revision,0) then raise exception 'Answer changed' using errcode='40001'; end if;
  if p_submit and a.feedback<>'each' then raise exception 'Submit the whole attempt first' using errcode='22023'; end if;
  perform exam_private.validate_answer(q.prompt,p_answer);
  v_revision:=coalesce(r.revision,0)+1;
  insert into public.exam_responses(attempt_id,user_id,number,answer,revision,submitted_at,auto_points,last_request,last_operation)
    values(a.id,a.user_id,p_number,p_answer,v_revision,case when p_submit then clock_timestamp() end,
      case when p_submit then exam_private.grade(a.exam_id,a.version,p_number,p_answer) end,p_request_id,operation)
    on conflict(attempt_id,number) do update set answer=excluded.answer,revision=excluded.revision,submitted_at=excluded.submitted_at,
      auto_points=excluded.auto_points,last_request=excluded.last_request,last_operation=excluded.last_operation;
  update public.exam_attempts set revision=revision+1,current_question=p_number where id=a.id;
  return public.exam_attempt_get(a.id);
end $$;

create function public.exam_attempt_submit(p_attempt_id uuid,p_expected_revision integer) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.exam_attempts; q exam_private.questions; v_now timestamptz:=clock_timestamp();
begin
  a:=exam_private.authorize(p_attempt_id);
  select * into a from public.exam_attempts where id=a.id for update;
  if a.submitted_at is not null then return public.exam_attempt_get(a.id); end if;
  if a.revision is distinct from p_expected_revision then raise exception 'Attempt changed' using errcode='40001'; end if;
  for q in select * from exam_private.questions where exam_id=a.exam_id and version=a.version loop
    insert into public.exam_responses(attempt_id,user_id,number) values(a.id,a.user_id,q.number) on conflict do nothing;
    update public.exam_responses set submitted_at=v_now,auto_points=exam_private.grade(a.exam_id,a.version,q.number,answer),revision=revision+1
      where attempt_id=a.id and number=q.number and submitted_at is null;
  end loop;
  update public.exam_attempts set submitted_at=v_now,revision=revision+1 where id=a.id;
  return public.exam_attempt_get(a.id);
end $$;

create function public.exam_guidance(p_attempt_id uuid,p_number integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts; q exam_private.questions; k exam_private.keys;
begin
  a:=exam_private.authorize(p_attempt_id);
  if a.submitted_at is null and (a.feedback<>'each' or not exists(select 1 from public.exam_responses where attempt_id=a.id and number=p_number and submitted_at is not null)) then
    raise exception 'Submit before viewing guidance' using errcode='42501';
  end if;
  select * into q from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number;
  select * into k from exam_private.keys where exam_id=a.exam_id and version=a.version and number=p_number;
  if not found then raise exception 'Guidance unavailable' using errcode='22023'; end if;
  return jsonb_build_object('source','Offisiell sensorveiledning','source_name',(select source_name from exam_private.exams where exam_id=a.exam_id and version=a.version),
    'pages',q.source_pages,'correct',case when q.review_status='verified' then k.correct else '{}'::jsonb end,
    'assets',coalesce((select jsonb_agg(jsonb_build_object('id',asset_id,'base64',content_base64) order by asset_id)
      from exam_private.assets where exam_id=a.exam_id and version=a.version and asset_id=any(k.guide_assets) and purpose='guide' and number=p_number),'[]'::jsonb));
end $$;

create function public.exam_prompt_asset(p_attempt_id uuid,p_asset_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts; result jsonb;
begin
  a:=exam_private.authorize(p_attempt_id);
  select jsonb_build_object('id',asset_id,'base64',content_base64) into result from exam_private.assets
    where exam_id=a.exam_id and version=a.version and asset_id=p_asset_id and purpose='prompt';
  if result is null then raise exception 'Image unavailable' using errcode='42501'; end if;
  return result;
end $$;

create function public.exam_self_assess(p_attempt_id uuid,p_number integer,p_expected_revision integer,p_assessment text,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.exam_attempts; r public.exam_responses; q exam_private.questions; operation jsonb;
begin
  a:=exam_private.authorize(p_attempt_id);
  select * into a from public.exam_attempts where id=a.id for update;
  select * into r from public.exam_responses where attempt_id=a.id and number=p_number;
  select * into q from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number;
  operation:=jsonb_build_object('assessment',p_assessment);
  if p_request_id is null or p_assessment is not null and p_assessment not in ('full','partial','none') then raise exception 'Invalid assessment' using errcode='22023'; end if;
  if r.last_request=p_request_id then
    if r.last_operation is distinct from operation then raise exception 'Retry conflict' using errcode='40001'; end if;
    return public.exam_attempt_get(a.id);
  end if;
  if r.submitted_at is null or q.grading='automatic' then raise exception 'Assessment unavailable' using errcode='42501'; end if;
  if r.revision is distinct from p_expected_revision then raise exception 'Assessment changed' using errcode='40001'; end if;
  update public.exam_responses set self_assessment=p_assessment,revision=revision+1,last_request=p_request_id,last_operation=operation where attempt_id=a.id and number=p_number;
  return public.exam_attempt_get(a.id);
end $$;

-- Private importer, executable only by the migration/database owner.
create function exam_private.import_package(p_package jsonb,p_grantee uuid default null) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare e jsonb:=p_package->'exam'; q jsonb; image jsonb;
begin
  if exists(select 1 from exam_private.exams where exam_id=e->>'id' and version=(e->>'version')::integer and package_sha256<>p_package->>'package_sha256') then
    raise exception 'Create a new content version instead of overwriting' using errcode='22023';
  end if;
  insert into exam_private.exams values(e->>'id',(e->>'version')::integer,e->>'title',e->>'course',e->>'source_name',e->>'source_sha256',
    p_package->>'package_sha256',e->>'introduction',(e->>'duration_minutes')::integer) on conflict do nothing;
  for q in select * from jsonb_array_elements(p_package->'questions') loop
    insert into exam_private.questions values(e->>'id',(e->>'version')::integer,(q->>'number')::integer,q->>'title',q->>'kind',
      (q->>'max_points')::numeric,array(select jsonb_array_elements_text(q->'source_pages')::integer),q->'prompt',q->>'review_status',q->>'review_note',q->>'grading') on conflict do nothing;
    insert into exam_private.keys values(e->>'id',(e->>'version')::integer,(q->>'number')::integer,coalesce(q->'correct','{}'),
      array(select jsonb_array_elements_text(q->'guide_assets'))) on conflict do nothing;
  end loop;
  for image in select * from jsonb_array_elements(p_package->'assets') loop
    insert into exam_private.assets values(e->>'id',(e->>'version')::integer,image->>'id',(image->>'number')::integer,
      image->>'purpose',image->>'base64') on conflict do nothing;
  end loop;
  if p_grantee is not null then insert into exam_private.access values(e->>'id',(e->>'version')::integer,p_grantee) on conflict do nothing; end if;
end $$;

revoke all on all functions in schema exam_private from public,anon,authenticated;
revoke all on function public.exam_catalogue(),public.exam_attempt_get(uuid),public.exam_attempt_start(uuid,text,integer,text,text,boolean),
  public.exam_response_save(uuid,integer,integer,jsonb,boolean,uuid),public.exam_attempt_submit(uuid,integer),
  public.exam_guidance(uuid,integer),public.exam_prompt_asset(uuid,text),public.exam_self_assess(uuid,integer,integer,text,uuid) from public,anon;
grant execute on function public.exam_catalogue(),public.exam_attempt_get(uuid),public.exam_attempt_start(uuid,text,integer,text,text,boolean),
  public.exam_response_save(uuid,integer,integer,jsonb,boolean,uuid),public.exam_attempt_submit(uuid,integer),
  public.exam_guidance(uuid,integer),public.exam_prompt_asset(uuid,text),public.exam_self_assess(uuid,integer,integer,text,uuid) to authenticated;
commit;
