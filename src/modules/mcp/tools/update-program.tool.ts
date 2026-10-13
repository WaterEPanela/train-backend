import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
import { ProgramOperationSchema } from "@/src/modules/mcp/schemas/program-operations.schema";
import { jsonResult } from "@/src/modules/mcp/tools/program-slots";

const KNOWN_ERRORS: Record<string, string> = {
  program_not_found: "That program does not exist or does not belong to the user.",
  revision_conflict:
    "The program changed since you read it. Call get_program again and rebuild the operations.",
  not_found: "An id in the operations is not part of this program.",
  invalid_operation: "One operation is not valid.",
  invalid_program: "The result would leave the program incomplete or inconsistent.",
};

export function registerUpdateProgramTool(server: McpServer) {
  server.registerTool(
    "update_program",
    {
      title: "Update program",
      description:
        "Edits one of the user's programs (made by an agent or by the user in the app) " +
        "with a list of operations addressed by the ids from get_program. Send only " +
        "what changes, never the whole program. Operations run in order, in a single " +
        "transaction: if any fails, or the result is incomplete (a phase without " +
        "session slots, a slot without activities, overlapping or mixed phase weeks), " +
        "nothing is applied. Fields in set are replaced as given; progression_rule " +
        "is replaced whole. Removing a phase, slot, activity or step keeps its logged " +
        "history: get_logs returns those measurements with in_plan=false and " +
        "removed_from_plan=true. Removing the current step moves the activity to the " +
        "next step. Pass expected_revision (from get_program) so changes made in the " +
        "meantime are not overwritten. To apply the same change to many items use " +
        "update_steps / update_activities with a list of ids instead of one operation " +
        "per item, and keep related changes in one call so they apply atomically. Describe the changes to the user and get their " +
        "agreement before calling it, especially removals.",
      inputSchema: {
        program_id: z.uuid(),
        expected_revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("program.revision as returned by get_program."),
        operations: z.array(ProgramOperationSchema).min(1).max(500),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ program_id, expected_revision, operations }) => {
      const accessToken = await resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      const { data, error } = await supabase.rpc("update_program", {
        program_id,
        operations,
        expected_revision: expected_revision ?? null,
      });

      if (error) {
        return jsonResult(
          {
            error: error.message,
            message: KNOWN_ERRORS[error.message] ?? error.message,
            details: error.details || undefined,
            applied: 0,
          },
          true,
        );
      }

      return jsonResult(data);
    },
  );
}
