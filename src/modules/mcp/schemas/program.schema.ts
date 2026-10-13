import { z } from "zod";

export const OnTriggerSchema = z
  .object({
    action: z.string(),
    reset_value_to: z
      .number()
      .optional()
      .describe("Value the target restarts at on the next step (e.g. 8 reps)."),
  })
  .passthrough();

export const ProgressionRuleSchema = z
  .object({
    type: z.string(),
    metric: z.string(),
    condition: z.string(),
    value: z
      .number()
      .describe("Threshold the measurements are compared against (e.g. 12)."),
    scope: z.string(),
    on_trigger: OnTriggerSchema,
  })
  .passthrough();

export const LadderStepSchema = z
  .object({
    label: z.string(),
    target_metric: z.string(),
    target_value: z.string().optional(),
    target_range: z.string().optional(),
    target_sets: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Exact recommended number of sets for this step (e.g. 3), never a range: " +
          "if the source says '2-3 sets', pick the number yourself and explain why in source_note. " +
          "Required when target_metric is 'reps'; omit it for activities without sets.",
      ),
    progression_rule: ProgressionRuleSchema,
  })
  .refine(
    (step) =>
      step.target_value !== undefined || step.target_range !== undefined,
    {
      message: "Each ladder step needs target_value or target_range",
    },
  )
  .refine(
    (step) => step.target_metric !== "reps" || step.target_sets !== undefined,
    {
      message:
        "Steps measured in reps need target_sets: an exact number of sets, not a range",
      path: ["target_sets"],
    },
  );

export const ActivitySchema = z.object({
  label: z.string(),
  rest_seconds: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Rest between sets in seconds (e.g. 90)."),
  ladder: z.array(LadderStepSchema).min(1),
});

export const SessionSlotSchema = z.object({
  label: z.string(),
  collapse_priority: z.number().int(),
  activities: z.array(ActivitySchema).min(1),
});

export const PhaseSchema = z
  .object({
    name: z.string(),
    week_start: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First week of the phase. Omit both week fields for an open-ended plan."),
    week_end: z.number().int().positive().optional(),
    goal: z.string().optional(),
    deload_weeks: z.array(z.number().int()).default([]),
    session_slots: z.array(SessionSlotSchema).min(1),
  })
  .refine(
    (phase) =>
      (phase.week_start === undefined) === (phase.week_end === undefined) &&
      (phase.week_start === undefined || phase.week_start <= phase.week_end!),
    { message: "week_start and week_end go together, with week_start <= week_end" },
  );

export const CollapseRulesSchema = z
  .object({
    min_slots_per_week: z.number().int().optional(),
    min_activities_per_slot: z.number().int().optional(),
  })
  .passthrough();

export const ProgramInputSchema = z.object({
  name: z.string(),
  source_note: z.string().optional(),
  collapse_rules: CollapseRulesSchema.default({}),
  phases: z.array(PhaseSchema).min(1),
});

export type ProgramInput = z.infer<typeof ProgramInputSchema>;
