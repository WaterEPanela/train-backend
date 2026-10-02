import { z } from "zod";

export const OnTriggerSchema = z
  .object({
    action: z.string(),
    reset_value_to: z.string().optional(),
  })
  .passthrough();

export const ProgressionRuleSchema = z
  .object({
    type: z.string(),
    metric: z.string(),
    condition: z.string(),
    value: z.union([z.number(), z.string()]),
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
    progression_rule: ProgressionRuleSchema,
  })
  .refine(
    (step) =>
      step.target_value !== undefined || step.target_range !== undefined,
    {
      message: "Cada ladder step necesita target_value o target_range",
    },
  );

export const ActivitySchema = z.object({
  label: z.string(),
  ladder: z.array(LadderStepSchema).min(1),
});

export const SessionSlotSchema = z.object({
  label: z.string(),
  collapse_priority: z.number().int(),
  activities: z.array(ActivitySchema).min(1),
});

export const PhaseSchema = z.object({
  name: z.string(),
  week_start: z.number().int(),
  week_end: z.number().int(),
  goal: z.string().optional(),
  deload_weeks: z.array(z.number().int()).default([]),
  session_slots: z.array(SessionSlotSchema).min(1),
});

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
