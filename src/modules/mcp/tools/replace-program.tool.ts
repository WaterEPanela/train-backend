import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
import { ProgramInputSchema } from "@/src/modules/mcp/schemas/program.schema";
import {
  isProgramNotFoundError,
  jsonResult,
} from "@/src/modules/mcp/tools/program-slots";

export function registerReplaceProgramTool(server: McpServer) {
  server.registerTool(
    "replace_program",
    {
      title: "Replace program",
      description:
        "Deletes one of the user's programs (with its whole session history) " +
        "and creates the new one in its slot, in a single transaction. Use it " +
        "only after import_program returned 'slots_full' and the user explicitly " +
        "chose which program to replace. The deletion cannot be undone.",
      inputSchema: {
        program: ProgramInputSchema,
        replace_program_id: z
          .uuid()
          .describe(
            "id of the program the user chose to replace (from the list import_program returned).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ program, replace_program_id }) => {
      const accessToken = await resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      const { data, error } = await supabase.rpc("import_program", {
        payload: program,
        replace_program_id,
      });

      if (error && isProgramNotFoundError(error)) {
        return jsonResult(
          {
            error: "program_not_found",
            message:
              "That program does not exist or does not belong to the user. Nothing was deleted or created.",
          },
          true,
        );
      }

      if (error) return jsonResult({ error: error.message }, true);

      return jsonResult({ program_id: data, replaced_program_id: replace_program_id });
    },
  );
}
