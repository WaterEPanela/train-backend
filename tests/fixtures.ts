import type { SupabaseClient } from "@supabase/supabase-js";

import type { ProgramInput } from "@/src/modules/mcp/schemas/program.schema";

const allSetsAtLeast12 = {
  type: "reps_threshold",
  metric: "reps",
  condition: ">=",
  value: 12,
  scope: "all_sets",
  on_trigger: { action: "advance_step", reset_value_to: 8 },
};

/** One phase, one session, two activities. Push-ups advance from knee to full at 3×12. */
export function sampleProgram(name = "Home calisthenics"): ProgramInput {
  return {
    name,
    collapse_rules: {},
    phases: [
      {
        name: "Base",
        week_start: 1,
        week_end: 4,
        deload_weeks: [],
        session_slots: [
          {
            label: "Upper body",
            collapse_priority: 1,
            activities: [
              {
                label: "Push-ups",
                ladder: [
                  { label: "Knee push-ups", target_metric: "reps", target_value: "12", target_sets: 3, progression_rule: allSetsAtLeast12 },
                  { label: "Full push-ups", target_metric: "reps", target_value: "8", target_sets: 3, progression_rule: allSetsAtLeast12 },
                ],
              },
              {
                label: "Rows",
                ladder: [
                  { label: "Table rows", target_metric: "reps", target_value: "10", target_sets: 3, progression_rule: allSetsAtLeast12 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function importProgram(db: SupabaseClient, program = sampleProgram()) {
  const { data, error } = await db.rpc("import_program", { payload: program });
  if (error) throw error;
  return data as string;
}

/** Ids of the sample program, looked up by label. */
export async function programIds(db: SupabaseClient, programId: string) {
  const { data, error } = await db
    .from("session_slots")
    .select("id, phases!inner(program_id), activities(id, label, current_step_id, ladder_steps!ladder_steps_activity_id_fkey(id, label))")
    .eq("phases.program_id", programId)
    .single();
  if (error) throw error;

  const activity = (label: string) => data.activities.find((a) => a.label === label)!;
  const step = (activityLabel: string, label: string) =>
    activity(activityLabel).ladder_steps.find((s) => s.label === label)!;

  return {
    slotId: data.id as string,
    pushUps: activity("Push-ups"),
    rows: activity("Rows"),
    kneePushUps: step("Push-ups", "Knee push-ups"),
    fullPushUps: step("Push-ups", "Full push-ups"),
  };
}

export async function getProgram(db: SupabaseClient, programId: string) {
  const { data, error } = await db.from("programs").select("name, revision").eq("id", programId).single();
  if (error) throw error;
  return data;
}
