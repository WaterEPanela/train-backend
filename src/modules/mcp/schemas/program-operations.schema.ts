import { z } from "zod";

import {
  ActivitySchema,
  LadderStepSchema,
  PhaseSchema,
  ProgressionRuleSchema,
  SessionSlotSchema,
} from "@/src/modules/mcp/schemas/program.schema";

const position = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("1-based position among its siblings; omitted means last.");

const UpdateProgramInfo = z.object({
  op: z.literal("update_program_info"),
  set: z
    .object({
      name: z.string().min(1),
      source_note: z.string().nullable(),
      collapse_rules: z.record(z.string(), z.unknown()),
      start_date: z.iso.date().describe("Week 1 of the program (YYYY-MM-DD)."),
    })
    .partial(),
});

const AddPhase = z.object({ op: z.literal("add_phase"), phase: PhaseSchema });

const UpdatePhase = z.object({
  op: z.literal("update_phase"),
  phase_id: z.uuid(),
  set: z
    .object({
      name: z.string().min(1),
      goal: z.string().nullable(),
      week_start: z.number().int().positive().nullable(),
      week_end: z.number().int().positive().nullable(),
      deload_weeks: z.array(z.number().int()),
    })
    .partial()
    .describe("Send week_start and week_end together (both null for an open-ended phase)."),
});

const RemovePhase = z.object({ op: z.literal("remove_phase"), phase_id: z.uuid() });

const AddSessionSlot = z.object({
  op: z.literal("add_session_slot"),
  phase_id: z.uuid(),
  position,
  session_slot: SessionSlotSchema,
});

const UpdateSessionSlot = z.object({
  op: z.literal("update_session_slot"),
  session_slot_id: z.uuid(),
  set: z
    .object({
      label: z.string().min(1),
      collapse_priority: z.number().int(),
      position: z.number().int().positive(),
    })
    .partial(),
});

const RemoveSessionSlot = z.object({
  op: z.literal("remove_session_slot"),
  session_slot_id: z.uuid(),
});

const AddActivity = z.object({
  op: z.literal("add_activity"),
  session_slot_id: z.uuid(),
  position,
  activity: ActivitySchema,
});

const UpdateActivity = z.object({
  op: z.literal("update_activity"),
  activity_id: z.uuid(),
  set: z
    .object({
      label: z.string().min(1),
      rest_seconds: z.number().int().nonnegative().nullable(),
      position: z.number().int().positive(),
      session_slot_id: z.uuid().describe("Moves the activity to another session slot of the program."),
      current_step_id: z
        .uuid()
        .describe("Sets the step the user is on, e.g. to regress after an injury."),
    })
    .partial(),
});

const UpdateActivities = z.object({
  op: z.literal("update_activities"),
  activity_ids: z.array(z.uuid()).min(1),
  set: UpdateActivity.shape.set.pick({ rest_seconds: true }),
});

const RemoveActivity = z.object({
  op: z.literal("remove_activity"),
  activity_id: z.uuid(),
});

const AddStep = z.object({
  op: z.literal("add_step"),
  activity_id: z.uuid(),
  position,
  step: LadderStepSchema,
});

const UpdateStep = z.object({
  op: z.literal("update_step"),
  step_id: z.uuid(),
  set: z
    .object({
      label: z.string().min(1),
      target_metric: z.string().min(1),
      target_value: z.string(),
      target_sets: z
        .number()
        .int()
        .positive()
        .describe("Exact recommended number of sets, never a range."),
      progression_rule: ProgressionRuleSchema.describe("Replaces the whole rule."),
      position: z.number().int().positive(),
    })
    .partial(),
});

const UpdateSteps = z.object({
  op: z.literal("update_steps"),
  step_ids: z.array(z.uuid()).min(1),
  set: UpdateStep.shape.set.omit({ label: true, position: true }),
});

const RemoveStep = z.object({ op: z.literal("remove_step"), step_id: z.uuid() });

export const ProgramOperationSchema = z.discriminatedUnion("op", [
  UpdateProgramInfo,
  AddPhase,
  UpdatePhase,
  RemovePhase,
  AddSessionSlot,
  UpdateSessionSlot,
  RemoveSessionSlot,
  AddActivity,
  UpdateActivity,
  UpdateActivities,
  RemoveActivity,
  AddStep,
  UpdateStep,
  UpdateSteps,
  RemoveStep,
]);

export type ProgramOperation = z.infer<typeof ProgramOperationSchema>;
