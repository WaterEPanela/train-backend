alter table public.measurement_logs
  drop constraint measurement_logs_activity_id_fkey,
  drop constraint measurement_logs_step_id_fkey,
  drop constraint measurement_logs_target_check,
  add column detached_at timestamptz,
  add constraint measurement_logs_activity_id_fkey
    foreign key (activity_id) references public.activities (id),
  add constraint measurement_logs_step_id_fkey
    foreign key (step_id) references public.ladder_steps (id),
  add constraint measurement_logs_target_check check (
    (step_id is null or activity_id is not null)
    and (activity_id is not null or adhoc_label is not null)
    and (step_id is not null or adhoc_label is not null)
  );

alter table public.ladder_steps
  drop constraint ladder_steps_activity_id_step_order_key,
  add constraint ladder_steps_activity_id_step_order_key
    unique (activity_id, step_order) deferrable initially deferred;

alter table public.programs
  add column revision int not null default 1;

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.insert_step(p_activity_id uuid, p_step jsonb, p_order int, p_id uuid default null)
returns uuid
language sql
set search_path = ''
as $$
  insert into public.ladder_steps (
    id, user_id, activity_id, label, target_metric, target_value, target_sets,
    progression_rule, step_order
  )
  values (
    coalesce(p_id, gen_random_uuid()),
    auth.uid(),
    p_activity_id,
    p_step->>'label',
    p_step->>'target_metric',
    coalesce(p_step->>'target_value', p_step->>'target_range', ''),
    (p_step->>'target_sets')::int,
    coalesce(p_step->'progression_rule', '{}'::jsonb),
    p_order
  )
  returning id;
$$;

create or replace function private.insert_activity(p_slot_id uuid, p_activity jsonb, p_position int)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_activity_id uuid := gen_random_uuid();
  v_first_step_id uuid := gen_random_uuid();
  v_step jsonb;
  v_order int := 0;
begin
  if jsonb_array_length(coalesce(p_activity->'ladder', '[]'::jsonb)) = 0 then
    raise exception 'invalid_operation'
      using errcode = 'P0001',
            detail = format('activity %L needs at least one ladder step', p_activity->>'label');
  end if;

  insert into public.activities (
    id, user_id, session_slot_id, label, current_step_id, position, rest_seconds
  )
  values (
    v_activity_id,
    auth.uid(),
    p_slot_id,
    p_activity->>'label',
    v_first_step_id,
    p_position,
    (p_activity->>'rest_seconds')::int
  );

  for v_step in select * from jsonb_array_elements(p_activity->'ladder')
  loop
    v_order := v_order + 1;
    perform private.insert_step(
      v_activity_id, v_step, v_order,
      case when v_order = 1 then v_first_step_id end
    );
  end loop;

  return v_activity_id;
end;
$$;

create or replace function private.insert_session_slot(p_phase_id uuid, p_slot jsonb, p_position int)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_slot_id uuid;
  v_activity jsonb;
  v_position int := 0;
begin
  insert into public.session_slots (user_id, phase_id, label, collapse_priority, position)
  values (
    auth.uid(),
    p_phase_id,
    p_slot->>'label',
    coalesce((p_slot->>'collapse_priority')::int, p_position),
    p_position
  )
  returning id into v_slot_id;

  for v_activity in select * from jsonb_array_elements(coalesce(p_slot->'activities', '[]'::jsonb))
  loop
    v_position := v_position + 1;
    perform private.insert_activity(v_slot_id, v_activity, v_position);
  end loop;

  return v_slot_id;
end;
$$;

create or replace function private.insert_phase(p_program_id uuid, p_phase jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_phase_id uuid;
  v_slot jsonb;
  v_position int := 0;
begin
  insert into public.phases (user_id, program_id, name, week_start, week_end, goal, deload_weeks)
  values (
    auth.uid(),
    p_program_id,
    p_phase->>'name',
    (p_phase->>'week_start')::int,
    (p_phase->>'week_end')::int,
    p_phase->>'goal',
    coalesce(
      (select array_agg(week::int) from jsonb_array_elements_text(p_phase->'deload_weeks') as week),
      '{}'::int[]
    )
  )
  returning id into v_phase_id;

  for v_slot in select * from jsonb_array_elements(coalesce(p_phase->'session_slots', '[]'::jsonb))
  loop
    v_position := v_position + 1;
    perform private.insert_session_slot(v_phase_id, v_slot, v_position);
  end loop;

  return v_phase_id;
end;
$$;

create or replace function private.detach_logs(p_activity_ids uuid[], p_step_ids uuid[] default '{}')
returns void
language sql
set search_path = ''
as $$
  update public.measurement_logs ml
  set adhoc_label = coalesce(
        ml.adhoc_label,
        (select ls.label from public.ladder_steps ls where ls.id = ml.step_id),
        (select a.label from public.activities a where a.id = ml.activity_id)),
      activity_id = case when ml.activity_id = any (p_activity_ids) then null else ml.activity_id end,
      step_id = null,
      detached_at = now()
  where ml.activity_id = any (p_activity_ids) or ml.step_id = any (p_step_ids);
$$;

create or replace function private.place(
  p_table text, p_parent_column text, p_order_column text, p_id uuid, p_position int
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_parent uuid;
  v_count int;
begin
  execute format('select %I from public.%I where id = $1', p_parent_column, p_table)
    into v_parent using p_id;

  execute format('select count(*) from public.%I where %I = $1', p_table, p_parent_column)
    into v_count using v_parent;

  execute format(
    $sql$
      with ordered as (
        select id, row_number() over (order by %3$I, created_at, id) as rn
        from public.%1$I
        where %2$I = $1 and id <> $2
      )
      update public.%1$I t
      set %3$I = case when o.rn >= $3 then o.rn + 1 else o.rn end
      from ordered o
      where t.id = o.id
    $sql$,
    p_table, p_parent_column, p_order_column
  ) using v_parent, p_id, least(greatest(p_position, 1), v_count);

  execute format('update public.%I set %I = $2 where id = $1', p_table, p_order_column)
    using p_id, least(greatest(p_position, 1), v_count);
end;
$$;

create or replace function private.program_of(p_kind text, p_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case p_kind
    when 'phase' then (select program_id from public.phases where id = p_id)
    when 'session_slot' then (
      select p.program_id from public.session_slots s
      join public.phases p on p.id = s.phase_id
      where s.id = p_id)
    when 'activity' then (
      select p.program_id from public.activities a
      join public.session_slots s on s.id = a.session_slot_id
      join public.phases p on p.id = s.phase_id
      where a.id = p_id)
    when 'step' then (
      select p.program_id from public.ladder_steps ls
      join public.activities a on a.id = ls.activity_id
      join public.session_slots s on s.id = a.session_slot_id
      join public.phases p on p.id = s.phase_id
      where ls.id = p_id)
  end;
$$;

grant execute on all functions in schema private to authenticated;

create or replace function public.import_program(payload jsonb, replace_program_id uuid default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_program_id uuid;
  v_phase jsonb;
begin
  if v_user_id is null then
    raise exception 'import_program requires an authenticated user';
  end if;

  if replace_program_id is not null then
    delete from public.programs
    where id = replace_program_id and user_id = v_user_id;

    if not found then
      raise exception 'program_not_found'
        using errcode = 'P0002',
              detail = format('No program %s for this user', replace_program_id);
    end if;
  end if;

  insert into public.programs (user_id, name, source_note, collapse_rules, origin)
  values (
    v_user_id,
    payload->>'name',
    payload->>'source_note',
    coalesce(payload->'collapse_rules', '{}'::jsonb),
    coalesce(nullif(payload->>'origin', ''), 'agent')
  )
  returning id into v_program_id;

  for v_phase in select * from jsonb_array_elements(coalesce(payload->'phases', '[]'::jsonb))
  loop
    perform private.insert_phase(v_program_id, v_phase);
  end loop;

  return v_program_id;
end;
$$;

create or replace function public.update_program(
  program_id uuid,
  operations jsonb,
  expected_revision int default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_program_id uuid := update_program.program_id;
  v_revision int;
  v_op jsonb;
  v_index int := 0;
  v_kind text;
  v_set jsonb;
  v_id uuid;
  v_ids uuid[];
  v_parent uuid;
  v_created jsonb := '[]'::jsonb;
  v_step record;
  v_replacement uuid;
  v_problem text;
  v_warnings jsonb;
begin
  if auth.uid() is null then
    raise exception 'update_program requires an authenticated user';
  end if;

  select p.revision into v_revision
  from public.programs p
  where p.id = v_program_id
  for update;

  if not found then
    raise exception 'program_not_found' using errcode = 'P0002';
  end if;

  if expected_revision is not null and expected_revision <> v_revision then
    raise exception 'revision_conflict'
      using errcode = 'P0001',
            detail = format('expected revision %s, current is %s', expected_revision, v_revision);
  end if;

  if jsonb_typeof(operations) <> 'array' or jsonb_array_length(operations) = 0 then
    raise exception 'invalid_operation' using errcode = 'P0001', detail = 'operations must be a non-empty array';
  end if;

  for v_op in select * from jsonb_array_elements(operations)
  loop
    v_index := v_index + 1;
    v_kind := v_op->>'op';
    v_set := coalesce(v_op->'set', '{}'::jsonb);

    if v_kind in ('update_activities', 'update_steps') then
      v_ids := array(
        select jsonb_array_elements_text(
          v_op->(case v_kind when 'update_activities' then 'activity_ids' else 'step_ids' end)
        )::uuid
      );
      v_kind := case v_kind when 'update_activities' then 'update_activity' else 'update_step' end;
      if coalesce(cardinality(v_ids), 0) = 0 then
        raise exception 'invalid_operation'
          using errcode = 'P0001', detail = format('operation %s: the id list is empty', v_index);
      end if;
    else
      v_ids := array[case v_kind
        when 'update_phase' then (v_op->>'phase_id')::uuid
        when 'remove_phase' then (v_op->>'phase_id')::uuid
        when 'update_session_slot' then (v_op->>'session_slot_id')::uuid
        when 'remove_session_slot' then (v_op->>'session_slot_id')::uuid
        when 'update_activity' then (v_op->>'activity_id')::uuid
        when 'remove_activity' then (v_op->>'activity_id')::uuid
        when 'update_step' then (v_op->>'step_id')::uuid
        when 'remove_step' then (v_op->>'step_id')::uuid
      end];
    end if;

    v_parent := case v_kind
      when 'add_session_slot' then (v_op->>'phase_id')::uuid
      when 'add_activity' then (v_op->>'session_slot_id')::uuid
      when 'add_step' then (v_op->>'activity_id')::uuid
    end;

    foreach v_id in array v_ids
    loop

    if v_id is not null and private.program_of(
      case
        when v_kind like '%phase' then 'phase'
        when v_kind like '%session_slot' then 'session_slot'
        when v_kind like '%activity' then 'activity'
        else 'step'
      end, v_id) is distinct from v_program_id
    or v_parent is not null and private.program_of(
      case v_kind
        when 'add_session_slot' then 'phase'
        when 'add_activity' then 'session_slot'
        else 'activity'
      end, v_parent) is distinct from v_program_id
    then
      raise exception 'not_found'
        using errcode = 'P0002',
              detail = format('operation %s (%s): %s is not part of this program', v_index, v_op->>'op', coalesce(v_id, v_parent));
    end if;

    case v_kind
      when 'update_program_info' then
        update public.programs p set
          name = case when v_set ? 'name' then v_set->>'name' else p.name end,
          source_note = case when v_set ? 'source_note' then v_set->>'source_note' else p.source_note end,
          collapse_rules = case when v_set ? 'collapse_rules' then v_set->'collapse_rules' else p.collapse_rules end,
          start_date = case when v_set ? 'start_date' then (v_set->>'start_date')::date else p.start_date end
        where p.id = v_program_id;

      when 'add_phase' then
        v_id := private.insert_phase(v_program_id, v_op->'phase');
        v_created := v_created || jsonb_build_object('operation', v_index, 'phase_id', v_id);

      when 'update_phase' then
        update public.phases ph set
          name = case when v_set ? 'name' then v_set->>'name' else ph.name end,
          goal = case when v_set ? 'goal' then v_set->>'goal' else ph.goal end,
          week_start = case when v_set ? 'week_start' then (v_set->>'week_start')::int else ph.week_start end,
          week_end = case when v_set ? 'week_end' then (v_set->>'week_end')::int else ph.week_end end,
          deload_weeks = case when v_set ? 'deload_weeks' then coalesce(
            (select array_agg(week::int) from jsonb_array_elements_text(v_set->'deload_weeks') as week),
            '{}'::int[]) else ph.deload_weeks end
        where ph.id = v_id;

      when 'remove_phase' then
        perform private.detach_logs(array(
          select a.id from public.activities a
          join public.session_slots s on s.id = a.session_slot_id
          where s.phase_id = v_id));
        delete from public.phases where id = v_id;

      when 'add_session_slot' then
        v_id := private.insert_session_slot(v_parent, v_op->'session_slot',
          (select count(*)::int + 1 from public.session_slots where phase_id = v_parent));
        if v_op ? 'position' then
          perform private.place('session_slots', 'phase_id', 'position', v_id, (v_op->>'position')::int);
        end if;
        v_created := v_created || jsonb_build_object('operation', v_index, 'session_slot_id', v_id);

      when 'update_session_slot' then
        update public.session_slots s set
          label = case when v_set ? 'label' then v_set->>'label' else s.label end,
          collapse_priority = case when v_set ? 'collapse_priority' then (v_set->>'collapse_priority')::int else s.collapse_priority end
        where s.id = v_id;
        if v_set ? 'position' then
          perform private.place('session_slots', 'phase_id', 'position', v_id, (v_set->>'position')::int);
        end if;

      when 'remove_session_slot' then
        perform private.detach_logs(array(
          select a.id from public.activities a where a.session_slot_id = v_id));
        delete from public.session_slots where id = v_id;

      when 'add_activity' then
        v_id := private.insert_activity(v_parent, v_op->'activity',
          (select count(*)::int + 1 from public.activities where session_slot_id = v_parent));
        if v_op ? 'position' then
          perform private.place('activities', 'session_slot_id', 'position', v_id, (v_op->>'position')::int);
        end if;
        v_created := v_created || jsonb_build_object('operation', v_index, 'activity_id', v_id);

      when 'update_activity' then
        if v_set ? 'session_slot_id'
          and private.program_of('session_slot', (v_set->>'session_slot_id')::uuid) is distinct from v_program_id then
          raise exception 'not_found'
            using errcode = 'P0002',
                  detail = format('operation %s: session slot %s is not part of this program', v_index, v_set->>'session_slot_id');
        end if;
        if v_set ? 'current_step_id' and not exists (
          select 1 from public.ladder_steps
          where id = (v_set->>'current_step_id')::uuid and activity_id = v_id) then
          raise exception 'invalid_operation'
            using errcode = 'P0001',
                  detail = format('operation %s: current_step_id must be a step of this activity', v_index);
        end if;

        update public.activities a set
          label = case when v_set ? 'label' then v_set->>'label' else a.label end,
          rest_seconds = case when v_set ? 'rest_seconds' then (v_set->>'rest_seconds')::int else a.rest_seconds end,
          current_step_id = case when v_set ? 'current_step_id' then (v_set->>'current_step_id')::uuid else a.current_step_id end,
          session_slot_id = case when v_set ? 'session_slot_id' then (v_set->>'session_slot_id')::uuid else a.session_slot_id end,
          position = case when v_set ? 'session_slot_id' and not v_set ? 'position'
            then (select count(*)::int + 1 from public.activities where session_slot_id = (v_set->>'session_slot_id')::uuid)
            else a.position end
        where a.id = v_id;
        if v_set ? 'position' then
          perform private.place('activities', 'session_slot_id', 'position', v_id, (v_set->>'position')::int);
        end if;

      when 'remove_activity' then
        perform private.detach_logs(array[v_id]);
        delete from public.activities where id = v_id;

      when 'add_step' then
        v_id := private.insert_step(v_parent, v_op->'step',
          (select coalesce(max(step_order), 0) + 1 from public.ladder_steps where activity_id = v_parent));
        if v_op ? 'position' then
          perform private.place('ladder_steps', 'activity_id', 'step_order', v_id, (v_op->>'position')::int);
        end if;
        v_created := v_created || jsonb_build_object('operation', v_index, 'step_id', v_id);

      when 'update_step' then
        update public.ladder_steps ls set
          label = case when v_set ? 'label' then v_set->>'label' else ls.label end,
          target_metric = case when v_set ? 'target_metric' then v_set->>'target_metric' else ls.target_metric end,
          target_value = case when v_set ? 'target_value' then coalesce(v_set->>'target_value', '') else ls.target_value end,
          target_sets = case when v_set ? 'target_sets' then (v_set->>'target_sets')::int else ls.target_sets end,
          progression_rule = case when v_set ? 'progression_rule' then coalesce(v_set->'progression_rule', '{}'::jsonb) else ls.progression_rule end
        where ls.id = v_id;
        if v_set ? 'position' then
          perform private.place('ladder_steps', 'activity_id', 'step_order', v_id, (v_set->>'position')::int);
        end if;

      when 'remove_step' then
        select ls.activity_id, ls.step_order, a.current_step_id into v_step
        from public.ladder_steps ls
        join public.activities a on a.id = ls.activity_id
        where ls.id = v_id;

        if v_step.current_step_id = v_id then
          select id into v_replacement
          from public.ladder_steps
          where activity_id = v_step.activity_id and id <> v_id
          order by (step_order < v_step.step_order), step_order
          limit 1;

          if v_replacement is null then
            raise exception 'invalid_operation'
              using errcode = 'P0001',
                    detail = format('operation %s: cannot remove the only step of an activity; use remove_activity', v_index);
          end if;

          update public.activities set current_step_id = v_replacement where id = v_step.activity_id;
        end if;

        perform private.detach_logs('{}', array[v_id]);
        delete from public.ladder_steps where id = v_id;

      else
        raise exception 'invalid_operation'
          using errcode = 'P0001',
                detail = format('operation %s: unknown op %L', v_index, v_kind);
    end case;
    end loop;
  end loop;

  update public.session_slots s set position = o.rn
  from (
    select s2.id, row_number() over (partition by s2.phase_id order by s2.position, s2.created_at, s2.id) as rn
    from public.session_slots s2
    join public.phases ph on ph.id = s2.phase_id
    where ph.program_id = v_program_id
  ) o
  where s.id = o.id and s.position is distinct from o.rn;

  update public.activities a set position = o.rn
  from (
    select a2.id, row_number() over (partition by a2.session_slot_id order by a2.position, a2.created_at, a2.id) as rn
    from public.activities a2
    join public.session_slots s on s.id = a2.session_slot_id
    join public.phases ph on ph.id = s.phase_id
    where ph.program_id = v_program_id
  ) o
  where a.id = o.id and a.position is distinct from o.rn;

  update public.ladder_steps ls set step_order = o.rn
  from (
    select ls2.id, row_number() over (partition by ls2.activity_id order by ls2.step_order, ls2.created_at, ls2.id) as rn
    from public.ladder_steps ls2
    join public.activities a on a.id = ls2.activity_id
    join public.session_slots s on s.id = a.session_slot_id
    join public.phases ph on ph.id = s.phase_id
    where ph.program_id = v_program_id
  ) o
  where ls.id = o.id and ls.step_order is distinct from o.rn;

  select problem into v_problem
  from (
    select 'the program needs at least one phase' as problem
    where not exists (select 1 from public.phases where phases.program_id = v_program_id)
    union all
    select format('phase %L needs at least one session slot', ph.name)
    from public.phases ph
    where ph.program_id = v_program_id
      and not exists (select 1 from public.session_slots s where s.phase_id = ph.id)
    union all
    select format('session slot %L needs at least one activity', s.label)
    from public.session_slots s
    join public.phases ph on ph.id = s.phase_id
    where ph.program_id = v_program_id
      and not exists (select 1 from public.activities a where a.session_slot_id = s.id)
    union all
    select 'phases must all have weeks or all be open-ended'
    from public.phases ph
    where ph.program_id = v_program_id
    having count(*) filter (where ph.week_start is null) not in (0, count(*))
    union all
    select format('phases %L and %L overlap in weeks', a.name, b.name)
    from public.phases a
    join public.phases b on b.program_id = a.program_id and a.id < b.id
    where a.program_id = v_program_id
      and a.week_start is not null and b.week_start is not null
      and int4range(a.week_start, a.week_end, '[]') && int4range(b.week_start, b.week_end, '[]')
  ) problems
  limit 1;

  if v_problem is not null then
    raise exception 'invalid_program' using errcode = 'P0001', detail = v_problem;
  end if;

  select case when count(*) = 0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
    'code', 'missing_target_sets',
    'message', 'Steps measured in reps without an exact target_sets',
    'count', count(*),
    'step_ids', jsonb_agg(ls.id)
  )) end
  into v_warnings
  from public.ladder_steps ls
  join public.activities a on a.id = ls.activity_id
  join public.session_slots s on s.id = a.session_slot_id
  join public.phases ph on ph.id = s.phase_id
  where ph.program_id = v_program_id
    and ls.target_metric = 'reps'
    and ls.target_sets is null;

  update public.programs p set revision = p.revision + 1
  where p.id = v_program_id
  returning p.revision into v_revision;

  return jsonb_build_object(
    'program_id', v_program_id,
    'revision', v_revision,
    'applied', v_index,
    'created', v_created,
    'warnings', v_warnings
  );
end;
$$;

grant execute on function public.update_program(uuid, jsonb, int) to authenticated;
