alter table public.playground_progress
  add column if not exists assessment_version integer not null default 1
  check (assessment_version > 0);

-- Existing completions remain version 1. Results from different assessment
-- versions are never compared when selecting the best completion.
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
    insert into public.playground_progress(owner_id, lesson_id, completed_at, best_p95, cost, assessment_version)
      values(account_id, item->>'lessonId', (item->>'completedAt')::timestamptz, (item->>'bestP95')::double precision, (item->>'cost')::double precision, coalesce((item->>'assessmentVersion')::integer, 1))
    on conflict(owner_id, lesson_id) do update set
      completed_at = case
        when excluded.assessment_version > public.playground_progress.assessment_version then excluded.completed_at
        when excluded.assessment_version < public.playground_progress.assessment_version then public.playground_progress.completed_at
        else least(public.playground_progress.completed_at, excluded.completed_at) end,
      best_p95 = case
        when excluded.assessment_version > public.playground_progress.assessment_version then excluded.best_p95
        when excluded.assessment_version < public.playground_progress.assessment_version then public.playground_progress.best_p95
        else least(public.playground_progress.best_p95, excluded.best_p95) end,
      cost = case
        when excluded.assessment_version > public.playground_progress.assessment_version then excluded.cost
        when excluded.assessment_version < public.playground_progress.assessment_version then public.playground_progress.cost
        when excluded.best_p95 < public.playground_progress.best_p95 then excluded.cost
        when excluded.best_p95 = public.playground_progress.best_p95 then least(public.playground_progress.cost, excluded.cost)
        else public.playground_progress.cost end,
      assessment_version = greatest(public.playground_progress.assessment_version, excluded.assessment_version);
  end loop;

  if (select count(*) from public.playground_designs where owner_id = account_id and deleted_at is null) > 100
    or (select count(*) from public.playground_designs where owner_id = account_id and deleted_at is not null) > 10000
    or (select count(*) from public.playground_progress where owner_id = account_id) > 1000 then
    raise exception 'Account save limit exceeded';
  end if;

  select jsonb_build_object(
    'designs', coalesce((select jsonb_agg(design) from public.playground_designs where owner_id = account_id and deleted_at is null), '[]'::jsonb),
    'deleted', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'updatedAt', updated_at)) from public.playground_designs where owner_id = account_id and deleted_at is not null), '[]'::jsonb),
    'progress', coalesce((select jsonb_agg(jsonb_build_object('lessonId', lesson_id, 'completedAt', completed_at, 'bestP95', best_p95, 'cost', cost, 'assessmentVersion', assessment_version)) from public.playground_progress where owner_id = account_id), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.sync_playground(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sync_playground(jsonb, jsonb, jsonb) to authenticated;
