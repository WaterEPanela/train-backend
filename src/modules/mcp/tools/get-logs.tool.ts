import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
import { jsonResult } from "@/src/modules/mcp/tools/program-slots";

type MeasurementRow = {
  activity_id: string | null;
  step_id: string | null;
  adhoc_label: string | null;
  metric_type: string;
  value: number;
  sequence: number;
  extra: Record<string, unknown> | null;
  detached_at: string | null;
  activities: { label: string } | null;
  ladder_steps: { label: string; target_sets: number | null } | null;
};

export function registerGetLogsTool(server: McpServer) {
  server.registerTool(
    "get_logs",
    {
      title: "Get logs",
      description:
        "Returns the user's logged sessions, newest first, with every " +
        "measurement: the activity and ladder step it belongs to, the step's " +
        "recommended target_sets, metric, value and set order. Measurements with " +
        "in_plan=false are extras the user did outside the plan, or parts of the plan " +
        "removed later (removed_from_plan=true, labelled as they were when logged). Use it to audit " +
        "progress, adherence and the user's own plans (origin='user' in get_program) " +
        "before giving feedback or proposing changes.",
      inputSchema: z.object({
        program_id: z.uuid().optional().describe("Only sessions of this program."),
        from: z.iso.date().optional().describe("First date included (YYYY-MM-DD)."),
        to: z.iso.date().optional().describe("Last date included (YYYY-MM-DD)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of sessions."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ program_id, from, to, limit }) => {
      const accessToken = await resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      let query = supabase
        .from("session_logs")
        .select(
          "id, program_id, session_slot_id, session_slot_label, date, duration_seconds, notes, " +
            "measurement_logs(activity_id, step_id, adhoc_label, metric_type, value, sequence, extra, detached_at, " +
            "activities(label), ladder_steps(label, target_sets))",
        )
        .order("date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);

      if (program_id) query = query.eq("program_id", program_id);
      if (from) query = query.gte("date", from);
      if (to) query = query.lte("date", to);

      const { data, error } = await query;
      if (error) return jsonResult({ error: error.message }, true);

      const sessions = (data as unknown as (Record<string, unknown> & {
        measurement_logs: MeasurementRow[];
      })[]).map(({ measurement_logs, ...session }) => ({
        ...session,
        measurements: measurement_logs
          .sort(
            (a, b) =>
              (a.activity_id ?? a.adhoc_label ?? "").localeCompare(
                b.activity_id ?? b.adhoc_label ?? "",
              ) || a.sequence - b.sequence,
          )
          .map((m) => ({
            activity: m.activities?.label ?? m.adhoc_label,
            activity_id: m.activity_id,
            step: m.ladder_steps?.label ?? (m.activity_id ? m.adhoc_label : null),
            step_id: m.step_id,
            target_sets: m.ladder_steps?.target_sets ?? null,
            in_plan: m.step_id !== null,
            removed_from_plan: m.detached_at !== null,
            metric: m.metric_type,
            value: Number(m.value),
            sequence: m.sequence,
            extra: m.extra,
          })),
      }));

      return jsonResult({ sessions });
    },
  );
}
