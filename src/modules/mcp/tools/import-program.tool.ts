import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getUserClient } from "@/src/modules/supabase/client";
import { ProgramInputSchema } from "@/src/modules/mcp/schemas/program.schema";
import {
  getSlotSummary,
  isSlotsFullError,
  jsonResult,
} from "@/src/modules/mcp/tools/program-slots";

export function registerImportProgramTool(server: McpServer) {
  server.registerTool(
    "import_program",
    {
      title: "Import program",
      description:
        "Creates a complete Program (phases, session_slots, activities, ladder, " +
        "progression_rule, collapse_rules) for the authenticated user. " +
        "Each program takes one of the user's slots (free accounts have 1). " +
        "It never deletes anything: if no slot is free it fails with error " +
        "'slots_full' and returns the user's current programs. In that case, ask " +
        "the user which one to replace (warning them that program and all its " +
        "history will be deleted) and call replace_program with the id they pick. " +
        "Never choose which program to replace yourself.",
      inputSchema: z.object({ program: ProgramInputSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ program }) => {
      const supabase = await getUserClient();

      const { data, error } = await supabase.rpc("import_program", {
        payload: program,
      });

      if (error && isSlotsFullError(error)) {
        const summary = await getSlotSummary(supabase);
        return jsonResult(
          {
            error: "slots_full",
            message:
              `The user is using ${summary.used} of ${summary.slots} slots. ` +
              "To import this program they must choose one to replace (it is " +
              "deleted along with its history) or get more slots.",
            ...summary,
          },
          true,
        );
      }

      if (error) return jsonResult({ error: error.message }, true);

      return jsonResult({ program_id: data });
    },
  );
}
