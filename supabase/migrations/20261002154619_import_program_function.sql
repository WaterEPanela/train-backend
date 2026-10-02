create or replace function public.import_program(payload jsonb)
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
  v_activity jsonb;
  v_activity_id uuid;
  v_step jsonb;
  v_step_id uuid;
  v_first_step_id uuid;
  v_step_order int;
begin
  if v_user_id is null then
    raise exception 'import_program requires an authenticated user';
  end if;

  insert into public.programs (user_id, name, source_note, collapse_rules)
  values (
    v_user_id,
    payload->>'name',
    payload->>'source_note',
    coalesce(payload->'collapse_rules', '{}'::jsonb)
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

    for v_slot in select * from jsonb_array_elements(coalesce(v_phase->'session_slots', '[]'::jsonb))
    loop
      insert into public.session_slots (user_id, phase_id, label, collapse_priority)
      values (
        v_user_id,
        v_phase_id,
        v_slot->>'label',
        (v_slot->>'collapse_priority')::int
      )
      returning id into v_slot_id;

      for v_activity in select * from jsonb_array_elements(coalesce(v_slot->'activities', '[]'::jsonb))
      loop
        v_activity_id := gen_random_uuid();
        v_first_step_id := gen_random_uuid();

        insert into public.activities (id, user_id, session_slot_id, label, current_step_id)
        values (v_activity_id, v_user_id, v_slot_id, v_activity->>'label', v_first_step_id);

        v_step_order := 0;
        for v_step in select * from jsonb_array_elements(coalesce(v_activity->'ladder', '[]'::jsonb))
        loop
          v_step_order := v_step_order + 1;
          v_step_id := case when v_step_order = 1 then v_first_step_id else gen_random_uuid() end;

          insert into public.ladder_steps (
            id, user_id, activity_id, label, target_metric, target_value, progression_rule, step_order
          )
          values (
            v_step_id,
            v_user_id,
            v_activity_id,
            v_step->>'label',
            v_step->>'target_metric',
            coalesce(v_step->>'target_value', v_step->>'target_range'),
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

grant execute on function public.import_program(jsonb) to authenticated;
