import type { McpServer } from "@modelcontextprotocol/server";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
import { ProgramInputSchema } from "@/src/modules/mcp/schemas/program.schema";

export function registerImportProgramTool(server: McpServer) {
  server.registerTool(
    "import_program",
    {
      title: "Import program",
      description:
        "Crea un Program completo (fases, session_slots, activities, ladder, " +
          "progression_rule, collapse_rules) para el usuario autenticado. " +
          "No sobrescribe un programa existente — cada llamada crea uno nuevo.",
      inputSchema: { program: ProgramInputSchema },
    },
    async ({ program }) => {
      const accessToken = resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      const { data, error } = await supabase.rpc("import_program", {
        payload: program,
      });

      if (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: error.message }) },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify({ program_id: data }) },
        ],
      };
    },
  );
}
