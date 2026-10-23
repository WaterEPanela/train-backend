import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserClient } from "@/src/modules/supabase/client";
import { getSlotSummary, jsonResult } from "@/src/modules/mcp/tools/program-slots";

const PROGRAM_SELECT =
  "id, name, source_note, collapse_rules, start_date, origin, revision, created_at, " +
  "phases(id, name, week_start, week_end, goal, deload_weeks, " +
  "session_slots(id, label, collapse_priority, position, " +
  "activities(id, label, position, rest_seconds, current_step_id, " +
  "ladder_steps!ladder_steps_activity_id_fkey(id, label, target_metric, target_value, " +
  "target_sets, progression_rule, step_order))))";

type Step = {
  id: string;
  label: string;
  target_metric: string;
  target_value: string;
  target_sets: number | null;
  progression_rule: Record<string, unknown>;
  step_order: number;
};
type Activity = {
  id: string;
  label: string;
  position: number;
  rest_seconds: number | null;
  current_step_id: string;
  ladder_steps: Step[];
};
type Slot = {
  id: string;
  label: string;
  collapse_priority: number;
  position: number;
  activities: Activity[];
};
type Phase = {
  id: string;
  name: string;
  week_start: number | null;
  week_end: number | null;
  goal: string | null;
  deload_weeks: number[];
  session_slots: Slot[];
};
type Program = Record<string, unknown> & { phases: Phase[] };

type Selectors = {
  phase_ids?: string[];
  session_slot_ids?: string[];
  activity_ids?: string[];
  activity_label?: string;
};

function sortProgram(program: Program) {
  program.phases.sort((a, b) => (a.week_start ?? 0) - (b.week_start ?? 0));
  for (const phase of program.phases) {
    phase.session_slots.sort((a, b) => a.position - b.position);
    for (const slot of phase.session_slots) {
      slot.activities.sort((a, b) => a.position - b.position);
      for (const activity of slot.activities) {
        activity.ladder_steps.sort((a, b) => a.step_order - b.step_order);
      }
    }
  }
  return program;
}

function outline(program: Program) {
  return {
    ...program,
    phases: program.phases.map((phase) => ({
      ...phase,
      session_slots: phase.session_slots.map((slot) => ({
        ...slot,
        activities: slot.activities.map(({ ladder_steps, ...activity }) => {
          const current = ladder_steps.find((step) => step.id === activity.current_step_id);
          return {
            ...activity,
            steps_count: ladder_steps.length,
            current_step: current
              ? {
                  label: current.label,
                  target_metric: current.target_metric,
                  target_sets: current.target_sets,
                }
              : null,
          };
        }),
      })),
    })),
  };
}

function select(program: Program, selectors: Selectors) {
  const phaseIds = new Set(selectors.phase_ids);
  const slotIds = new Set(selectors.session_slot_ids);
  const activityIds = new Set(selectors.activity_ids);
  const label = selectors.activity_label?.trim().toLowerCase();
  const found = new Set<string>();

  const matchesActivity = (activity: Activity) => {
    if (activityIds.has(activity.id)) {
      found.add(activity.id);
      return true;
    }
    return Boolean(
      label &&
        (activity.label.toLowerCase().includes(label) ||
          activity.ladder_steps.some((step) => step.label.toLowerCase().includes(label))),
    );
  };

  const phases = program.phases.flatMap((phase) => {
    if (phaseIds.has(phase.id)) {
      found.add(phase.id);
      return [phase];
    }
    const slots = phase.session_slots.flatMap((slot) => {
      if (slotIds.has(slot.id)) {
        found.add(slot.id);
        return [slot];
      }
      const activities = slot.activities.filter(matchesActivity);
      return activities.length > 0 ? [{ ...slot, activities }] : [];
    });
    return slots.length > 0 ? [{ ...phase, session_slots: slots }] : [];
  });

  const missing = [...phaseIds, ...slotIds, ...activityIds].filter((id) => !found.has(id));
  return { program: { ...program, phases }, missing };
}

export function registerGetProgramTool(server: McpServer) {
  server.registerTool(
    "get_program",
    {
      title: "Get program",
      description:
        "Reads one of the authenticated user's programs, ordered by position, with its " +
        "revision for update_program. Without selectors it returns an outline: phases, " +
        "session slots and activities with only their current step; use it first to " +
        "find ids. With selectors it returns only the selected parts, complete (every " +
        "ladder step with target_value, target_sets and progression_rule), inside their " +
        "phase and session slot: phase_ids for whole phases, session_slot_ids for whole " +
        "sessions, activity_ids for single activities and activity_label to find an " +
        "exercise in every phase by name (case-insensitive, also matches step labels). " +
        "Selectors combine as a union. detail='full' without selectors returns the " +
        "whole program, which can be large. Without program_id it reads the most " +
        "recent program. It also returns the user's programs and slot usage.",
      inputSchema: z.object({
        program_id: z
          .uuid()
          .optional()
          .describe("id of one of the user's programs; defaults to the most recent."),
        phase_ids: z.array(z.uuid()).optional(),
        session_slot_ids: z.array(z.uuid()).optional(),
        activity_ids: z.array(z.uuid()).optional(),
        activity_label: z.string().min(2).optional(),
        detail: z
          .enum(["outline", "full"])
          .optional()
          .describe("Only without selectors: 'full' returns the whole program."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ program_id, detail, ...selectors }) => {
      const supabase = await getUserClient();

      let query = supabase.from("programs").select(PROGRAM_SELECT);
      query = program_id
        ? query.eq("id", program_id)
        : query.order("created_at", { ascending: false }).limit(1);

      const [{ data, error }, summary] = await Promise.all([
        query.maybeSingle(),
        getSlotSummary(supabase),
      ]);

      if (error) return jsonResult({ error: error.message }, true);

      if (!data) {
        return jsonResult({
          program: null,
          message: program_id
            ? "That program does not exist or does not belong to the user."
            : "No program has been imported yet.",
          ...summary,
        });
      }

      const program = sortProgram(data as unknown as Program);
      const hasSelectors =
        Boolean(selectors.activity_label) ||
        [selectors.phase_ids, selectors.session_slot_ids, selectors.activity_ids].some(
          (ids) => ids && ids.length > 0,
        );

      if (!hasSelectors) {
        return jsonResult({
          program: detail === "full" ? program : outline(program),
          ...summary,
        });
      }

      const { program: selected, missing } = select(program, selectors);
      return jsonResult({
        program: selected,
        ...(missing.length > 0 ? { not_found: missing } : {}),
        ...(missing.length > 0 || selected.phases.length === 0
          ? {
              message:
                selected.phases.length === 0
                  ? "Nothing matched the selectors."
                  : "Some ids are not part of this program.",
            }
          : {}),
        ...summary,
      });
    },
  );
}
