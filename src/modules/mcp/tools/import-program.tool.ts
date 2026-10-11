import type { McpServer } from "@modelcontextprotocol/server";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
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
        "Crea un Program completo (fases, session_slots, activities, ladder, " +
        "progression_rule, collapse_rules) para el usuario autenticado. " +
        "Cada programa ocupa un slot del usuario (la cuenta gratuita tiene 1). " +
        "Nunca borra nada: si no queda ningún slot libre falla con " +
        "error 'slots_full' y devuelve la lista de programas actuales. En ese caso " +
        "pregúntale al usuario cuál quiere reemplazar (avisándole que ese programa " +
        "y todo su historial se borran) y usa replace_program con el id que elija. " +
        "Nunca elijas tú cuál reemplazar.",
      inputSchema: { program: ProgramInputSchema },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ program }) => {
      const accessToken = resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      const { data, error } = await supabase.rpc("import_program", {
        payload: program,
      });

      if (error && isSlotsFullError(error)) {
        const summary = await getSlotSummary(supabase);
        return jsonResult(
          {
            error: "slots_full",
            message:
              `El usuario está usando ${summary.used} de ${summary.slots} slots. ` +
              "Para importar este programa debe elegir cuál reemplazar (se borra " +
              "junto con su historial) o conseguir más slots.",
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
