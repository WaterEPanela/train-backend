alter table public.phases
  alter column week_start drop not null,
  alter column week_end drop not null,
  add constraint phases_weeks_check check (
    (week_start is null and week_end is null)
    or (week_start is not null and week_end is not null and week_start <= week_end)
  );

alter table public.programs
  add column origin text not null default 'agent' check (origin in ('agent', 'user'));

alter table public.measurement_logs
  alter column activity_id drop not null,
  alter column step_id drop not null,
  add column adhoc_label text,
  add constraint measurement_logs_target_check check (
    (activity_id is not null and step_id is not null and adhoc_label is null)
    or (activity_id is null and step_id is null and adhoc_label is not null)
  );

create or replace function public.import_program(payload jsonb, replace_program_id uuid default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_program_id uuid;
  v_phase jsonb;
  v_phase_id uuid;
  v_slot jsonb;
  v_slot_id uuid;
  v_slot_position int;
  v_activity jsonb;
  v_activity_id uuid;
  v_activity_position int;
  v_step jsonb;
  v_step_id uuid;
  v_first_step_id uuid;
  v_step_order int;
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
    insert into public.phases (user_id, program_id, name, week_start, week_end, goal, deload_weeks)
    values (
      v_user_id,
      v_program_id,
      v_phase->>'name',
      (v_phase->>'week_start')::int,
      (v_phase->>'week_end')::int,
      v_phase->>'goal',
      coalesce(
        (
          select array_agg(step::int)
          from jsonb_array_elements_text(coalesce(v_phase->'deload_weeks', '[]'::jsonb)) as step
        ),
        '{}'::int[]
      )
    )
    returning id into v_phase_id;

    v_slot_position := 0;
    for v_slot in select * from jsonb_array_elements(coalesce(v_phase->'session_slots', '[]'::jsonb))
    loop
      v_slot_position := v_slot_position + 1;

      insert into public.session_slots (user_id, phase_id, label, collapse_priority, position)
      values (
        v_user_id,
        v_phase_id,
        v_slot->>'label',
        (v_slot->>'collapse_priority')::int,
        v_slot_position
      )
      returning id into v_slot_id;

      v_activity_position := 0;
      for v_activity in select * from jsonb_array_elements(coalesce(v_slot->'activities', '[]'::jsonb))
      loop
        v_activity_position := v_activity_position + 1;
        v_activity_id := gen_random_uuid();
        v_first_step_id := gen_random_uuid();

        insert into public.activities (
          id, user_id, session_slot_id, label, current_step_id, position, rest_seconds
        )
        values (
          v_activity_id,
          v_user_id,
          v_slot_id,
          v_activity->>'label',
          v_first_step_id,
          v_activity_position,
          (v_activity->>'rest_seconds')::int
        );

        v_step_order := 0;
        for v_step in select * from jsonb_array_elements(coalesce(v_activity->'ladder', '[]'::jsonb))
        loop
          v_step_order := v_step_order + 1;
          v_step_id := case when v_step_order = 1 then v_first_step_id else gen_random_uuid() end;

          insert into public.ladder_steps (
            id, user_id, activity_id, label, target_metric, target_value, target_sets,
            progression_rule, step_order
          )
          values (
            v_step_id,
            v_user_id,
            v_activity_id,
            v_step->>'label',
            v_step->>'target_metric',
            coalesce(v_step->>'target_value', v_step->>'target_range'),
            (v_step->>'target_sets')::int,
            coalesce(v_step->'progression_rule', '{}'::jsonb),
            v_step_order
          );
        end loop;
      end loop;
    end loop;
  end loop;

  return v_program_id;
end;
$$;

create or replace function public.log_session(payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_program_id uuid := (payload->>'program_id')::uuid;
  v_slot_id uuid := nullif(payload->>'session_slot_id', '')::uuid;
  v_client_id uuid := nullif(payload->>'client_id', '')::uuid;
  v_label text := payload->>'session_slot_label';
  v_log_id uuid;
  v_measurement jsonb;
  v_step record;
  v_pair record;
  v_rule jsonb;
  v_values numeric[];
  v_next record;
  v_progressions jsonb := '[]'::jsonb;
  v_extra jsonb;
  v_value jsonb;
  v_sequence int;
  v_extra_activity_id uuid;
  v_extra_step_id uuid;
  v_added jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'log_session requires an authenticated user';
  end if;

  if v_client_id is not null then
    select id into v_log_id from public.session_logs where client_id = v_client_id;
    if found then
      return jsonb_build_object('session_log_id', v_log_id, 'duplicate', true, 'progressions', '[]'::jsonb);
    end if;
  end if;

  perform 1 from public.programs where id = v_program_id;
  if not found then
    raise exception 'program_not_found' using errcode = 'P0002';
  end if;

  if v_slot_id is not null then
    select s.label into v_label
    from public.session_slots s
    join public.phases p on p.id = s.phase_id
    where s.id = v_slot_id and p.program_id = v_program_id;

    if not found then
      raise exception 'session_slot_not_found' using errcode = 'P0002';
    end if;
  end if;

  if v_label is null then
    raise exception 'log_session needs session_slot_id or session_slot_label';
  end if;

  insert into public.session_logs (
    user_id, program_id, session_slot_id, session_slot_label, date, notes, duration_seconds, client_id
  )
  values (
    v_user_id,
    v_program_id,
    v_slot_id,
    v_label,
    coalesce((payload->>'date')::date, current_date),
    payload->>'notes',
    (payload->>'duration_seconds')::int,
    v_client_id
  )
  returning id into v_log_id;

  for v_measurement in select * from jsonb_array_elements(coalesce(payload->'measurements', '[]'::jsonb))
  loop
    select ls.id, ls.target_metric into v_step
    from public.ladder_steps ls
    join public.activities a on a.id = ls.activity_id
    join public.session_slots s on s.id = a.session_slot_id
    join public.phases p on p.id = s.phase_id
    where ls.id = (v_measurement->>'step_id')::uuid
      and a.id = (v_measurement->>'activity_id')::uuid
      and p.program_id = v_program_id;

    if not found then
      raise exception 'invalid_measurement'
        using errcode = 'P0002',
              detail = format('step %s is not part of activity %s in this program',
                v_measurement->>'step_id', v_measurement->>'activity_id');
    end if;

    insert into public.measurement_logs (
      user_id, session_log_id, activity_id, step_id, metric_type, value, sequence, extra
    )
    values (
      v_user_id,
      v_log_id,
      (v_measurement->>'activity_id')::uuid,
      v_step.id,
      coalesce(v_measurement->>'metric_type', v_step.target_metric),
      (v_measurement->>'value')::numeric,
      coalesce((v_measurement->>'sequence')::int, 1),
      v_measurement->'extra'
    );
  end loop;

  for v_extra in select * from jsonb_array_elements(coalesce(payload->'extras', '[]'::jsonb))
  loop
    if coalesce(v_extra->>'label', '') = '' or coalesce(v_extra->>'metric', '') = '' then
      raise exception 'invalid_extra' using errcode = 'P0001', detail = 'extras need label and metric';
    end if;

    v_extra_activity_id := null;
    v_extra_step_id := null;

    if coalesce((v_extra->>'add_to_plan')::boolean, false) then
      if v_slot_id is null then
        raise exception 'invalid_extra'
          using errcode = 'P0001', detail = 'add_to_plan needs session_slot_id';
      end if;

      v_extra_activity_id := gen_random_uuid();
      v_extra_step_id := gen_random_uuid();

      insert into public.activities (
        id, user_id, session_slot_id, label, current_step_id, position, rest_seconds
      )
      values (
        v_extra_activity_id,
        v_user_id,
        v_slot_id,
        v_extra->>'label',
        v_extra_step_id,
        (select coalesce(max(position), 0) + 1 from public.activities where session_slot_id = v_slot_id),
        (v_extra->>'rest_seconds')::int
      );

      insert into public.ladder_steps (
        id, user_id, activity_id, label, target_metric, target_value, target_sets,
        progression_rule, step_order
      )
      values (
        v_extra_step_id,
        v_user_id,
        v_extra_activity_id,
        v_extra->>'label',
        v_extra->>'metric',
        coalesce(v_extra->>'target_value', ''),
        (v_extra->>'target_sets')::int,
        '{}'::jsonb,
        1
      );

      v_added := v_added || jsonb_build_object(
        'activity_id', v_extra_activity_id,
        'step_id', v_extra_step_id,
        'label', v_extra->>'label'
      );
    end if;

    v_sequence := 0;
    for v_value in select * from jsonb_array_elements(coalesce(v_extra->'values', '[]'::jsonb))
    loop
      v_sequence := v_sequence + 1;
      insert into public.measurement_logs (
        user_id, session_log_id, activity_id, step_id, adhoc_label, metric_type, value, sequence
      )
      values (
        v_user_id,
        v_log_id,
        v_extra_activity_id,
        v_extra_step_id,
        case when v_extra_activity_id is null then v_extra->>'label' end,
        v_extra->>'metric',
        (v_value #>> '{}')::numeric,
        v_sequence
      );
    end loop;
  end loop;

  for v_pair in
    select distinct ml.activity_id, ml.step_id
    from public.measurement_logs ml
    join public.activities a on a.id = ml.activity_id and a.current_step_id = ml.step_id
    where ml.session_log_id = v_log_id
  loop
    select progression_rule, step_order, target_metric, target_sets into v_step
    from public.ladder_steps where id = v_pair.step_id;
    v_rule := v_step.progression_rule;

    if coalesce(v_rule->'on_trigger'->>'action', '') not in ('advance_step', 'advance_ladder') then
      continue;
    end if;

    select array_agg(value order by sequence) into v_values
    from public.measurement_logs
    where session_log_id = v_log_id
      and step_id = v_pair.step_id
      and metric_type = coalesce(v_rule->>'metric', v_step.target_metric);

    if not public.progression_rule_met(v_rule, v_values, v_step.target_sets) then
      continue;
    end if;

    select id, label into v_next
    from public.ladder_steps
    where activity_id = v_pair.activity_id and step_order > v_step.step_order
    order by step_order
    limit 1;

    if not found then
      continue;
    end if;

    update public.activities set current_step_id = v_next.id where id = v_pair.activity_id;

    v_progressions := v_progressions || jsonb_build_object(
      'activity_id', v_pair.activity_id,
      'from_step_id', v_pair.step_id,
      'to_step_id', v_next.id,
      'to_step_label', v_next.label
    );
  end loop;

  return jsonb_build_object(
    'session_log_id', v_log_id,
    'duplicate', false,
    'progressions', v_progressions,
    'added_activities', v_added
  );
end;
$$;

grant execute on function public.log_session(jsonb) to authenticated;
