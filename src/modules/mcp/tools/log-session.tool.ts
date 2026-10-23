import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserClient } from "@/src/modules/supabase/client";
import { jsonResult } from "@/src/modules/mcp/tools/program-slots";

const MeasurementSchema = z.object({
  activity_id: z.uuid().describe("Activity id (from get_program)."),
  step_id: z
    .uuid()
    .describe("Ladder step that was performed; usually the activity's current_step_id."),
  value: z.number().describe("Measured value: reps in one set, pages, minutes, etc."),
  metric_type: z
    .string()
    .optional()
    .describe("Metric of the value; defaults to the step's target_metric."),
  sequence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Set number or order (1, 2, 3…)."),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Free-form extra data (RPE, pace, perceived difficulty…)."),
});

const ExtraSchema = z.object({
  label: z.string().min(1).describe("Name of the activity done outside the plan."),
  metric: z.string().min(1).describe("Metric of its values: reps, minutes, pages…"),
  values: z
    .array(z.number())
    .min(1)
    .describe("One value per set (or a single value for activities without sets)."),
  add_to_plan: z
    .boolean()
    .optional()
    .describe(
      "Also append it to the session slot so it is part of the plan next time. " +
        "Only when the user asked for it; requires session_slot_id.",
    ),
  target_sets: z.number().int().positive().optional(),
  rest_seconds: z.number().int().nonnegative().optional(),
});

export function registerLogSessionTool(server: McpServer) {
  server.registerTool(
    "log_session",
    {
      title: "Log session",
      description:
        "Logs a completed session of one of the user's programs: one " +
        "measurement per set (or a single one for activities without sets, such " +
        "as reading or running). Ids come from get_program. On logging, the backend " +
        "evaluates " +
        "each activity's progression_rule and, when it is met, advances the " +
        "activity to the next ladder step; the response lists those advances. " +
        "Activities done outside the plan go in extras; they are logged by name " +
        "and only join the plan with add_to_plan. It only adds data and never " +
        "changes earlier sessions.",
      inputSchema: z.object({
        program_id: z.uuid(),
        client_id: z
          .uuid()
          .optional()
          .describe(
            "Generate one random uuid per session and reuse it if you retry the call; " +
              "a repeated client_id returns the first log instead of logging twice.",
          ),
        session_slot_id: z
          .uuid()
          .optional()
          .describe("Session slot that was performed (recommended)."),
        session_slot_label: z
          .string()
          .optional()
          .describe("Only when there is no session_slot_id."),
        date: z.iso
          .date()
          .optional()
          .describe("Session date (YYYY-MM-DD); defaults to today."),
        duration_seconds: z.number().int().nonnegative().optional(),
        notes: z
          .string()
          .optional()
          .describe("How the session went, in the user's words; used in later reviews."),
        measurements: z
          .array(MeasurementSchema)
          .default([])
          .describe("Measurements of activities that are part of the plan."),
        extras: z
          .array(ExtraSchema)
          .optional()
          .describe("Activities the user did that are not in the plan."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      if (input.measurements.length === 0 && !input.extras?.length) {
        return jsonResult(
          { error: "empty_session", message: "Provide measurements or extras." },
          true,
        );
      }

      const supabase = await getUserClient();

      const { data, error } = await supabase.rpc("log_session", { payload: input });

      if (error) {
        return jsonResult({ error: error.message, detail: error.details }, true);
      }

      return jsonResult(data);
    },
  );
}
