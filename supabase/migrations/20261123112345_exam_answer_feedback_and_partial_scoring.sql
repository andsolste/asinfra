-- Feedback never includes image data. Historical attempts retain the v1 rule.
begin;
alter table public.exam_attempts add column scoring_version smallint not null default 1
  check (scoring_version in (1,2));
alter table public.exam_attempts alter column scoring_version set default 2;

-- v2 applies proportional positive credit to questions containing only checkbox
-- fields. All fields share the question's original maximum. Each wrong selection
-- costs one point. Other automatic question types retain v1 all-or-nothing.
create function exam_private.grade_response(p_exam text,p_version integer,p_number integer,p_answer jsonb,p_scoring_version smallint) returns numeric
language plpgsql stable security invoker set search_path='' as $$
declare q exam_private.questions; k exam_private.keys; f jsonb; selected jsonb; expected jsonb;
  correct_total integer:=0; correct_selected integer:=0; wrong_selected integer:=0;
begin
  if p_scoring_version=1 then return exam_private.grade(p_exam,p_version,p_number,p_answer); end if;
  if p_scoring_version is distinct from 2 then raise exception 'Unknown scoring version' using errcode='22023'; end if;
  select * into q from exam_private.questions where exam_id=p_exam and version=p_version and number=p_number;
  if q.grading<>'automatic' or q.review_status<>'verified' then return null; end if;
  if jsonb_array_length(q.prompt->'fields')=0 or exists(
    select 1 from jsonb_array_elements(q.prompt->'fields') field where field->>'kind'<>'multiple'
  ) then return exam_private.grade(p_exam,p_version,p_number,p_answer); end if;
  select * into k from exam_private.keys where exam_id=p_exam and version=p_version and number=p_number;
  for f in select * from jsonb_array_elements(q.prompt->'fields') loop
    expected:=k.correct->(f->>'id'); selected:=coalesce(p_answer->(f->>'id'),'[]'::jsonb);
    if jsonb_typeof(expected) is distinct from 'array' or jsonb_array_length(expected)=0 then return null; end if;
    correct_total:=correct_total+jsonb_array_length(expected);
    correct_selected:=correct_selected+(select count(*) from jsonb_array_elements(selected) choice where expected @> jsonb_build_array(choice));
    wrong_selected:=wrong_selected+(select count(*) from jsonb_array_elements(selected) choice where not expected @> jsonb_build_array(choice));
  end loop;
  if correct_selected=correct_total and wrong_selected=0 then return q.max_points; end if;
  -- Truncate fractional credit to four decimals; never round up to full credit.
  return trunc(least(q.max_points,greatest(0,q.max_points*correct_selected/correct_total-wrong_selected)),4);
end $$;

-- One gate shared by lightweight feedback and original source guidance.
create function exam_private.authorize_feedback(p_attempt_id uuid,p_number integer) returns public.exam_attempts
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts;
begin
  a:=exam_private.authorize(p_attempt_id);
  if a.submitted_at is null and (a.feedback<>'each' or not exists(
    select 1 from public.exam_responses where attempt_id=a.id and number=p_number and submitted_at is not null
  )) then raise exception 'Submit before viewing feedback' using errcode='42501'; end if;
  if not exists(select 1 from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number) then
    raise exception 'Question unavailable' using errcode='22023';
  end if;
  return a;
end $$;

create function public.exam_feedback(p_attempt_id uuid,p_number integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts; q exam_private.questions; r public.exam_responses; k exam_private.keys;
  f jsonb; selected jsonb; expected jsonb; correct_fields integer:=0; field_total integer:=0;
  correct_choices integer:=0; wrong_choices integer:=0; available boolean;
begin
  a:=exam_private.authorize_feedback(p_attempt_id,p_number);
  select * into q from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number;
  select * into r from public.exam_responses where attempt_id=a.id and number=p_number;
  select * into k from exam_private.keys where exam_id=a.exam_id and version=a.version and number=p_number;
  available:=q.grading='automatic' and q.review_status='verified' and k.correct<>'{}';
  if available then
    for f in select * from jsonb_array_elements(q.prompt->'fields') loop
      expected:=k.correct->(f->>'id'); selected:=r.answer->(f->>'id');
      if expected is null or f->>'kind'='text' then continue; end if;
      field_total:=field_total+1;
      if f->>'kind'='multiple' then
        selected:=coalesce(selected,'[]'::jsonb);
        correct_choices:=correct_choices+(select count(*) from jsonb_array_elements(selected) choice where expected @> jsonb_build_array(choice));
        wrong_choices:=wrong_choices+(select count(*) from jsonb_array_elements(selected) choice where not expected @> jsonb_build_array(choice));
        if selected @> expected and expected @> selected then correct_fields:=correct_fields+1; end if;
      elsif selected=expected then correct_fields:=correct_fields+1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('attempt_id',a.id,'number',p_number,'response_revision',r.revision,
    'scoring_version',a.scoring_version,'available',available,'auto_points',r.auto_points,'max_points',q.max_points,
    'correct',case when available then k.correct else '{}'::jsonb end,
    'correct_fields',correct_fields,'total_fields',field_total,'correct_choices',correct_choices,'incorrect_choices',wrong_choices);
end $$;

-- Existing save/submit contracts and idempotency remain unchanged below.

create or replace function public.exam_response_save(p_attempt_id uuid,p_number integer,p_expected_revision integer,p_answer jsonb,p_submit boolean,p_request_id uuid) returns jsonb
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
      case when p_submit then exam_private.grade_response(a.exam_id,a.version,p_number,p_answer,a.scoring_version) end,p_request_id,operation)
    on conflict(attempt_id,number) do update set answer=excluded.answer,revision=excluded.revision,submitted_at=excluded.submitted_at,
      auto_points=excluded.auto_points,last_request=excluded.last_request,last_operation=excluded.last_operation;
  update public.exam_attempts set revision=revision+1,current_question=p_number where id=a.id;
  return public.exam_attempt_get(a.id);
end $$;

create or replace function public.exam_attempt_submit(p_attempt_id uuid,p_expected_revision integer) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.exam_attempts; q exam_private.questions; v_now timestamptz:=clock_timestamp();
begin
  a:=exam_private.authorize(p_attempt_id);
  select * into a from public.exam_attempts where id=a.id for update;
  if a.submitted_at is not null then return public.exam_attempt_get(a.id); end if;
  if a.revision is distinct from p_expected_revision then raise exception 'Attempt changed' using errcode='40001'; end if;
  for q in select * from exam_private.questions where exam_id=a.exam_id and version=a.version loop
    insert into public.exam_responses(attempt_id,user_id,number) values(a.id,a.user_id,q.number) on conflict do nothing;
    update public.exam_responses set submitted_at=v_now,auto_points=exam_private.grade_response(a.exam_id,a.version,q.number,answer,a.scoring_version),revision=revision+1
      where attempt_id=a.id and number=q.number and submitted_at is null;
  end loop;
  update public.exam_attempts set submitted_at=v_now,revision=revision+1 where id=a.id;
  return public.exam_attempt_get(a.id);
end $$;

create or replace function public.exam_guidance(p_attempt_id uuid,p_number integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.exam_attempts; q exam_private.questions; k exam_private.keys;
begin
  a:=exam_private.authorize_feedback(p_attempt_id,p_number);
  select * into q from exam_private.questions where exam_id=a.exam_id and version=a.version and number=p_number;
  select * into k from exam_private.keys where exam_id=a.exam_id and version=a.version and number=p_number;
  if not found then raise exception 'Guidance unavailable' using errcode='22023'; end if;
  return jsonb_build_object('source','Offisiell sensorveiledning','source_name',(select source_name from exam_private.exams where exam_id=a.exam_id and version=a.version),
    'pages',q.source_pages,'correct',case when q.review_status='verified' then k.correct else '{}'::jsonb end,
    'assets',coalesce((select jsonb_agg(jsonb_build_object('id',asset_id,'base64',content_base64) order by g.position)
      from unnest(k.guide_assets) with ordinality as g(id,position)
      join exam_private.assets image on image.asset_id=g.id and image.exam_id=a.exam_id and image.version=a.version
      where image.purpose='guide' and image.number=p_number),'[]'::jsonb));
end $$;

revoke all on function exam_private.grade_response(text,integer,integer,jsonb,smallint),exam_private.authorize_feedback(uuid,integer) from public,anon,authenticated;
revoke all on function public.exam_feedback(uuid,integer) from public,anon;
grant execute on function public.exam_feedback(uuid,integer) to authenticated;
commit;
