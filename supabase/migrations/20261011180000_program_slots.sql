create table public.user_entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  program_slots int not null default 1 check (program_slots >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.user_entitlements
  for each row execute function public.set_updated_at();

alter table public.user_entitlements enable row level security;

create policy "user can read own entitlements" on public.user_entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.program_slots_for(p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select program_slots from public.user_entitlements where user_id = p_user_id),
    1
  );
$$;

revoke execute on function public.program_slots_for(uuid) from public, anon, authenticated;

insert into public.user_entitlements (user_id, program_slots)
select user_id, count(*)
from public.programs
group by user_id
having count(*) > 1;

create or replace function public.enforce_program_slots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used int;
  v_slots int;
begin
  perform pg_advisory_xact_lock(hashtext('program_slots:' || new.user_id::text));

  select count(*) into v_used from public.programs where user_id = new.user_id;
  v_slots := public.program_slots_for(new.user_id);

  if v_used >= v_slots then
    raise exception 'slots_full'
      using errcode = 'P0001',
            detail = format('%s of %s program slots in use', v_used, v_slots),
            hint = 'Replace an existing program with replace_program_id, or get more slots.';
  end if;

  return new;
end;
$$;

create trigger enforce_program_slots
  before insert on public.programs
  for each row execute function public.enforce_program_slots();

alter table public.programs add column start_date date not null default current_date;
update public.programs set start_date = created_at::date;

alter table public.session_slots add column position int not null default 0;
alter table public.activities add column position int not null default 0;

update public.session_slots s
set position = ordered.position
from (
  select id, row_number() over (partition by phase_id order by label, id) as position
  from public.session_slots
) ordered
where s.id = ordered.id;

update public.activities a
set position = ordered.position
from (
  select id, row_number() over (partition by session_slot_id order by label, id) as position
  from public.activities
) ordered
where a.id = ordered.id;

drop function public.import_program(jsonb);

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

        insert into public.activities (id, user_id, session_slot_id, label, current_step_id, position)
        values (v_activity_id, v_user_id, v_slot_id, v_activity->>'label', v_first_step_id, v_activity_position);

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

grant execute on function public.import_program(jsonb, uuid) to authenticated;
