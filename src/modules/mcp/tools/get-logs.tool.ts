import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserClient } from "@/src/modules/supabase/client";
import { jsonResult } from "@/src/modules/mcp/tools/program-slots";

export const GetLogsInputSchema = z.object({
  program_id: z.uuid().optional().describe("Only sessions of this program."),
  activity_id: z
    .uuid()
    .optional()
    .describe("Only sessions that include this activity, with only its measurements."),
  session_log_id: z.uuid().optional().describe("Only this session."),
  from: z.iso.date().optional().describe("First date included (YYYY-MM-DD)."),
  to: z.iso.date().optional().describe("Last date included (YYYY-MM-DD)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of sessions."),
  cursor: z
    .object({ date: z.string(), created_at: z.string(), id: z.uuid() })
    .optional()
    .describe("next_cursor from a previous call, to read the following (older) page."),
});

export function registerGetLogsTool(server: McpServer) {
  server.registerTool(
    "get_logs",
    {
      title: "Get logs",
      description:
        "Returns the user's logged sessions, newest first, with every " +
        "measurement in plan order: the activity and ladder step it belongs to, the step's " +
        "recommended target_sets, metric, value and set order. Measurements with " +
        "in_plan=false are extras the user did outside the plan, or parts of the plan " +
        "removed later (removed_from_plan=true, labelled as they were when logged). " +
        "Each session also lists targets_met (step ids whose progression rule was met " +
        "in that session) and step_changes (activities that were on a different step " +
        "than in their previous session, with direction up or down). When next_cursor " +
        "is not null there are older sessions: pass it back as cursor. Use it to audit " +
        "progress, adherence and the user's own plans (origin='user' in get_program) " +
        "before giving feedback or proposing changes.",
      inputSchema: GetLogsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ program_id, activity_id, session_log_id, from, to, limit, cursor }) => {
      const supabase = await getUserClient();

      const { data, error } = await supabase.rpc("get_logs", {
        program_id,
        activity_id,
        session_log_id,
        from_date: from,
        to_date: to,
        max_sessions: limit,
        after: cursor,
      });
      if (error) return jsonResult({ error: error.message }, true);

      return jsonResult(data);
    },
  );
}
