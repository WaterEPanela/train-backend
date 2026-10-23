drop index public.session_logs_user_id_idx;
drop index public.session_logs_program_id_idx;
drop index public.measurement_logs_activity_id_idx;

create index session_logs_user_history_idx
  on public.session_logs (user_id, date desc, created_at desc, id desc);
create index session_logs_program_history_idx
  on public.session_logs (program_id, date desc, created_at desc, id desc);
create index measurement_logs_activity_id_session_log_id_idx
  on public.measurement_logs (activity_id, session_log_id);

alter table public.session_logs
  drop constraint session_logs_client_id_key,
  add constraint session_logs_user_id_client_id_key unique (user_id, client_id);

create or replace function public.get_logs(
  program_id uuid default null,
  activity_id uuid default null,
  session_log_id uuid default null,
  from_date date default null,
  to_date date default null,
  max_sessions int default 20,
  after jsonb default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(get_logs.max_sessions, 20), 1), 100) as page_size
  ),
  candidates as (
    select sl.*
    from public.session_logs sl
    where (get_logs.program_id is null or sl.program_id = get_logs.program_id)
      and (get_logs.session_log_id is null or sl.id = get_logs.session_log_id)
      and (get_logs.from_date is null or sl.date >= get_logs.from_date)
      and (get_logs.to_date is null or sl.date <= get_logs.to_date)
      and (get_logs.activity_id is null or exists (
        select 1 from public.measurement_logs ml
        where ml.session_log_id = sl.id and ml.activity_id = get_logs.activity_id))
      and (get_logs.after is null or (sl.date, sl.created_at, sl.id) < (
        (get_logs.after->>'date')::date,
        (get_logs.after->>'created_at')::timestamptz,
        (get_logs.after->>'id')::uuid))
    order by sl.date desc, sl.created_at desc, sl.id desc
    limit (select page_size + 1 from params)
  ),
  ranked as (
    select c.*, row_number() over (order by c.date desc, c.created_at desc, c.id desc) as rank
    from candidates c
  ),
  page as (
    select * from ranked where rank <= (select page_size from params)
  ),
  steps_per_session as (
    select distinct on (ml.activity_id, ml.session_log_id)
      ml.activity_id, ml.session_log_id, ml.step_id, ls.label, ls.step_order,
      sl.date, sl.created_at
    from public.measurement_logs ml
    join public.ladder_steps ls on ls.id = ml.step_id
    join public.session_logs sl on sl.id = ml.session_log_id
    where ml.activity_id in (
      select m.activity_id from public.measurement_logs m
      join page p on p.id = m.session_log_id
      where m.activity_id is not null)
    order by ml.activity_id, ml.session_log_id, ls.step_order desc
  ),
  step_history as (
    select s.*,
      lag(s.step_id) over w as previous_step_id,
      lag(s.label) over w as previous_label,
      lag(s.step_order) over w as previous_step_order
    from steps_per_session s
    window w as (partition by s.activity_id order by s.date, s.created_at, s.session_log_id)
  ),
  step_changes as (
    select h.session_log_id,
      jsonb_agg(jsonb_build_object(
        'activity_id', h.activity_id,
        'from_step_id', h.previous_step_id,
        'from_step_label', h.previous_label,
        'to_step_id', h.step_id,
        'to_step_label', h.label,
        'direction', case when h.step_order > h.previous_step_order then 'up' else 'down' end
      ) order by h.activity_id) as changes
    from step_history h
    where h.session_log_id in (select id from page)
      and h.previous_step_id is not null
      and h.previous_step_id <> h.step_id
    group by h.session_log_id
  ),
  step_values as (
    select ml.session_log_id, ml.step_id, ls.progression_rule, ls.target_sets,
      array_agg(ml.value order by ml.sequence) filter (
        where ml.metric_type = coalesce(ls.progression_rule->>'metric', ls.target_metric)
      ) as measured
    from public.measurement_logs ml
    join page p on p.id = ml.session_log_id
    join public.ladder_steps ls on ls.id = ml.step_id
    group by ml.session_log_id, ml.step_id, ls.progression_rule, ls.target_sets
  ),
  targets_met as (
    select v.session_log_id, jsonb_agg(v.step_id order by v.step_id) as step_ids
    from step_values v
    where public.progression_rule_met(v.progression_rule, v.measured, v.target_sets)
    group by v.session_log_id
  ),
  measurements as (
    select ml.session_log_id,
      jsonb_agg(jsonb_build_object(
        'activity', coalesce(a.label, ml.adhoc_label),
        'activity_id', ml.activity_id,
        'step', coalesce(ls.label, case when ml.activity_id is not null then ml.adhoc_label end),
        'step_id', ml.step_id,
        'target_sets', ls.target_sets,
        'in_plan', ml.step_id is not null,
        'removed_from_plan', ml.detached_at is not null,
        'metric', ml.metric_type,
        'value', ml.value,
        'sequence', ml.sequence,
        'extra', ml.extra
      ) order by ml.activity_id is null, a.position, ml.activity_id, ls.step_order,
                 ml.adhoc_label, ml.sequence) as items
    from public.measurement_logs ml
    join page p on p.id = ml.session_log_id
    left join public.activities a on a.id = ml.activity_id
    left join public.ladder_steps ls on ls.id = ml.step_id
    where get_logs.activity_id is null or ml.activity_id = get_logs.activity_id
    group by ml.session_log_id
  )
  select jsonb_build_object(
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'program_id', p.program_id,
        'program_name', pr.name,
        'session_slot_id', p.session_slot_id,
        'session_slot_label', p.session_slot_label,
        'date', p.date,
        'created_at', p.created_at,
        'duration_seconds', p.duration_seconds,
        'notes', p.notes,
        'measurements', coalesce(m.items, '[]'::jsonb),
        'step_changes', coalesce(sc.changes, '[]'::jsonb),
        'targets_met', coalesce(tm.step_ids, '[]'::jsonb)
      ) order by p.rank)
      from page p
      join public.programs pr on pr.id = p.program_id
      left join measurements m on m.session_log_id = p.id
      left join step_changes sc on sc.session_log_id = p.id
      left join targets_met tm on tm.session_log_id = p.id
    ), '[]'::jsonb),
    'next_cursor', (
      select jsonb_build_object('date', p.date, 'created_at', p.created_at, 'id', p.id)
      from page p
      where (select count(*) from candidates) > (select page_size from params)
      order by p.rank desc
      limit 1
    )
  );
$$;

create or replace function public.delete_session_log(session_log_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.session_logs where id = delete_session_log.session_log_id;
  if not found then
    raise exception 'session_log_not_found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.last_values(step_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(latest.step_id, latest.measured), '{}'::jsonb)
  from (
    select s.step_id,
      (select array_agg(ml.value order by ml.sequence)
       from public.measurement_logs ml
       where ml.step_id = s.step_id
         and ml.session_log_id = (
           select m.session_log_id from public.measurement_logs m
           where m.step_id = s.step_id
           order by m.created_at desc
           limit 1)) as measured
    from unnest(last_values.step_ids) as s(step_id)
  ) latest
  where latest.measured is not null;
$$;

grant execute on function public.get_logs(uuid, uuid, uuid, date, date, int, jsonb) to authenticated;
grant execute on function public.delete_session_log(uuid) to authenticated;
grant execute on function public.last_values(uuid[]) to authenticated;
