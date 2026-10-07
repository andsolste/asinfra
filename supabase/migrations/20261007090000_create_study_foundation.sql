begin;

create table public.subjects (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name text not null check (char_length(btrim(name)) between 1 and 120),
    code text check (code is null or char_length(code) <= 32),
    is_archived boolean not null default false,
    created_at timestamptz not null default now(),
    unique (id, user_id)
);

create table public.study_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    subject_id uuid,
    description text not null default '' check (char_length(description) <= 500),
    started_at timestamptz not null,
    ended_at timestamptz check (ended_at is null or ended_at >= started_at),
    created_at timestamptz not null default now(),
    -- Same-owner FK prevents cross-user links, including later updates.
    -- Preserve sessions if a subject is deleted, without nulling user_id (PG 15+).
    foreign key (subject_id, user_id) references public.subjects(id, user_id)
        on delete set null (subject_id)
);

create index subjects_user_id_idx on public.subjects(user_id);
create index study_sessions_user_started_idx on public.study_sessions(user_id, started_at);
create index study_sessions_subject_owner_idx on public.study_sessions(subject_id, user_id);

alter table public.subjects enable row level security;
alter table public.study_sessions enable row level security;

-- Remove inherited/default table grants before explicitly allowing own-row CRUD.
revoke all on public.subjects, public.study_sessions from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.subjects, public.study_sessions to authenticated;

create policy subjects_select_own on public.subjects for select to authenticated
    using ((select auth.uid()) = user_id);
create policy subjects_insert_own on public.subjects for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy subjects_update_own on public.subjects for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy subjects_delete_own on public.subjects for delete to authenticated
    using ((select auth.uid()) = user_id);

create policy study_sessions_select_own on public.study_sessions for select to authenticated
    using ((select auth.uid()) = user_id);
create policy study_sessions_insert_own on public.study_sessions for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy study_sessions_update_own on public.study_sessions for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy study_sessions_delete_own on public.study_sessions for delete to authenticated
    using ((select auth.uid()) = user_id);

commit;
