-- Esquema inicial de train-app (issue #4).
-- Modelo de datos: trAIn-app/PLAN.md sección 4. Tools MCP: sección 6.
--
-- Decisiones que van más allá del texto literal de PLAN.md (documentadas también
-- ahí, ver nota de implementación en secciones 4 y 6):
--   - user_id denormalizado en las 8 tablas (no solo programs/availability) para que
--     RLS no dependa de joins de hasta 4 niveles.
--   - updated_at + trigger en las 8 tablas.
--   - Policies acotadas explícitamente a `to authenticated`.
--   - supa_audit (sección 6, punto 4/4) NO se habilita acá: no está disponible en la
--     imagen local de Postgres de Supabase CLI (confirmado: 0 filas en
--     pg_available_extensions para supa_audit, Postgres 17.6 local). Requeriría
--     instalarlo vía pg_tle (sí disponible) trayendo el SQL fuente de la extensión —
--     se investiga aparte cuando se construya update_program, no en esta migración.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- programs
-- ============================================================
create table public.programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  source_note text,
  collapse_rules jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index programs_user_id_idx on public.programs (user_id);

create trigger set_updated_at
  before update on public.programs
  for each row execute function public.set_updated_at();

alter table public.programs enable row level security;

create policy "user can access own rows" on public.programs
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- phases
-- ============================================================
create table public.phases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  name text not null,
  week_start int not null,
  week_end int not null,
  goal text,
  deload_weeks int[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index phases_user_id_idx on public.phases (user_id);
create index phases_program_id_idx on public.phases (program_id);

create trigger set_updated_at
  before update on public.phases
  for each row execute function public.set_updated_at();

alter table public.phases enable row level security;

create policy "user can access own rows" on public.phases
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- session_slots
-- ============================================================
create table public.session_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  phase_id uuid not null references public.phases (id) on delete cascade,
  label text not null,
  collapse_priority int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index session_slots_user_id_idx on public.session_slots (user_id);
create index session_slots_phase_id_idx on public.session_slots (phase_id);

create trigger set_updated_at
  before update on public.session_slots
  for each row execute function public.set_updated_at();

alter table public.session_slots enable row level security;

create policy "user can access own rows" on public.session_slots
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- activities
-- current_step_id referencia a ladder_steps (creada más abajo) — dependencia
-- circular con ladder_steps.activity_id. El FK se agrega con ALTER TABLE una vez
-- que ladder_steps exista, marcado DEFERRABLE INITIALLY DEFERRED para que
-- import_program pueda insertar todo el árbol en una sola transacción (generando
-- los id de ladder_steps client-side antes del INSERT en vez de confiar en el
-- default de la tabla, solo para el step inicial que current_step_id apunta).
-- ============================================================
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_slot_id uuid not null references public.session_slots (id) on delete cascade,
  label text not null,
  current_step_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index activities_user_id_idx on public.activities (user_id);
create index activities_session_slot_id_idx on public.activities (session_slot_id);
create index activities_current_step_id_idx on public.activities (current_step_id);

create trigger set_updated_at
  before update on public.activities
  for each row execute function public.set_updated_at();

alter table public.activities enable row level security;

create policy "user can access own rows" on public.activities
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- ladder_steps
-- step_order preserva el orden del array ladder[] de PLAN.md (más fácil -> más
-- difícil) — no es un campo del modelo de dominio, es necesario para representar
-- un array ordenado en una tabla relacional.
-- ============================================================
create table public.ladder_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  label text not null,
  target_metric text not null,
  target_value text not null,
  progression_rule jsonb not null,
  step_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, step_order)
);

create index ladder_steps_user_id_idx on public.ladder_steps (user_id);
create index ladder_steps_activity_id_idx on public.ladder_steps (activity_id);

create trigger set_updated_at
  before update on public.ladder_steps
  for each row execute function public.set_updated_at();

alter table public.ladder_steps enable row level security;

create policy "user can access own rows" on public.ladder_steps
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- activities.current_step_id: FK diferido, ver nota en la sección de "activities".
alter table public.activities
  add constraint activities_current_step_id_fkey
  foreign key (current_step_id) references public.ladder_steps (id)
  on delete restrict
  deferrable initially deferred;

-- ============================================================
-- session_logs
-- session_slot_label es texto libre (no FK a session_slots) — así lo define
-- PLAN.md sección 4 explícitamente.
-- ============================================================
create table public.session_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  session_slot_label text not null,
  date date not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index session_logs_user_id_idx on public.session_logs (user_id);
create index session_logs_program_id_idx on public.session_logs (program_id);

create trigger set_updated_at
  before update on public.session_logs
  for each row execute function public.set_updated_at();

alter table public.session_logs enable row level security;

create policy "user can access own rows" on public.session_logs
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- measurement_logs
-- activity_id/step_id en on delete cascade (igual que el resto de la cadena
-- estructural): measurement_logs es hijo de la jerarquía completa del programa,
-- no solo de session_logs.
-- ============================================================
create table public.measurement_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_log_id uuid not null references public.session_logs (id) on delete cascade,
  activity_id uuid not null references public.activities (id) on delete cascade,
  step_id uuid not null references public.ladder_steps (id) on delete cascade,
  metric_type text not null,
  value numeric not null,
  sequence int not null default 1,
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index measurement_logs_user_id_idx on public.measurement_logs (user_id);
create index measurement_logs_session_log_id_idx on public.measurement_logs (session_log_id);
create index measurement_logs_activity_id_idx on public.measurement_logs (activity_id);
create index measurement_logs_step_id_idx on public.measurement_logs (step_id);

create trigger set_updated_at
  before update on public.measurement_logs
  for each row execute function public.set_updated_at();

alter table public.measurement_logs enable row level security;

create policy "user can access own rows" on public.measurement_logs
  for all
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- availability
-- ============================================================
create table public.availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index availability_user_id_idx on public.availability (user_id);

create trigger set_updated_at
  before update on public.availability
  for each row execute function public.set_updated_at();

alter table public.availability enable row level security;

create policy "user can access own rows" on public.availability
  for all
  to authenticated
  using ((select auth.uid()) = user_id);
