create table if not exists public.playground_designs (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) between 1 and 128),
  design jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  primary key (owner_id, id),
  check ((deleted_at is not null and design is null) or (deleted_at is null and jsonb_typeof(design) = 'object')),
  check (design is null or octet_length(design::text) <= 200000)
);

create table if not exists public.playground_progress (
  owner_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null check (length(lesson_id) between 1 and 128),
  completed_at timestamptz not null,
  best_p95 double precision not null check (best_p95 >= 0 and best_p95 <= 1000000000),
  cost double precision not null check (cost >= 0 and cost <= 1000000000),
  primary key (owner_id, lesson_id)
);

alter table public.playground_designs enable row level security;
alter table public.playground_progress enable row level security;

create policy "Users manage their own designs" on public.playground_designs
  for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "Users manage their own progress" on public.playground_progress
  for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.playground_designs to authenticated;
grant select, insert, update, delete on public.playground_progress to authenticated;
revoke all on public.playground_designs from anon;
revoke all on public.playground_progress from anon;

-- Merge on the server to prevent a slower client overwriting a newer save.
create or replace function public.sync_playground(p_designs jsonb, p_deleted jsonb, p_progress jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  item jsonb;
  result jsonb;
begin
  if account_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_designs) is distinct from 'array' or jsonb_typeof(p_deleted) is distinct from 'array' or jsonb_typeof(p_progress) is distinct from 'array'
    or jsonb_array_length(p_designs) > 100 or jsonb_array_length(p_deleted) > 10000 or jsonb_array_length(p_progress) > 1000
    or octet_length(p_designs::text) + octet_length(p_deleted::text) + octet_length(p_progress::text) > 5000000 then
    raise exception 'Invalid sync payload';
  end if;

  for item in select value from jsonb_array_elements(p_designs) loop
    if jsonb_typeof(item->'architecture') is distinct from 'object' or jsonb_typeof(item->'workload') is distinct from 'object'
      or coalesce(length(item->>'name'), 0) not between 1 and 120 then raise exception 'Invalid design'; end if;
    insert into public.playground_designs(owner_id, id, design, updated_at)
      values(account_id, item->>'id', item, (item->>'updatedAt')::timestamptz)
    on conflict(owner_id, id) do update
      set design = excluded.design, updated_at = excluded.updated_at, deleted_at = null
      where public.playground_designs.updated_at < excluded.updated_at;
  end loop;

  for item in select value from jsonb_array_elements(p_deleted) loop
    insert into public.playground_designs(owner_id, id, design, updated_at, deleted_at)
      values(account_id, item->>'id', null, (item->>'updatedAt')::timestamptz, (item->>'updatedAt')::timestamptz)
    on conflict(owner_id, id) do update
      set design = null, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
      where public.playground_designs.updated_at <= excluded.updated_at;
  end loop;

  for item in select value from jsonb_array_elements(p_progress) loop
    insert into public.playground_progress(owner_id, lesson_id, completed_at, best_p95, cost)
      values(account_id, item->>'lessonId', (item->>'completedAt')::timestamptz, (item->>'bestP95')::double precision, (item->>'cost')::double precision)
    on conflict(owner_id, lesson_id) do update set
      completed_at = least(public.playground_progress.completed_at, excluded.completed_at),
      best_p95 = least(public.playground_progress.best_p95, excluded.best_p95),
      cost = case
        when excluded.best_p95 < public.playground_progress.best_p95 then excluded.cost
        when excluded.best_p95 = public.playground_progress.best_p95 then least(public.playground_progress.cost, excluded.cost)
        else public.playground_progress.cost end;
  end loop;

  if (select count(*) from public.playground_designs where owner_id = account_id and deleted_at is null) > 100
    or (select count(*) from public.playground_designs where owner_id = account_id and deleted_at is not null) > 10000
    or (select count(*) from public.playground_progress where owner_id = account_id) > 1000 then
    raise exception 'Account save limit exceeded';
  end if;

  select jsonb_build_object(
    'designs', coalesce((select jsonb_agg(design) from public.playground_designs where owner_id = account_id and deleted_at is null), '[]'::jsonb),
    'deleted', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'updatedAt', updated_at)) from public.playground_designs where owner_id = account_id and deleted_at is not null), '[]'::jsonb),
    'progress', coalesce((select jsonb_agg(jsonb_build_object('lessonId', lesson_id, 'completedAt', completed_at, 'bestP95', best_p95, 'cost', cost)) from public.playground_progress where owner_id = account_id), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.sync_playground(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sync_playground(jsonb, jsonb, jsonb) to authenticated;
