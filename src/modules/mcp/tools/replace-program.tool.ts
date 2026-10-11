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
        "Borra uno de los programas del usuario (con todo su historial de " +
        "sesiones) y crea el nuevo en su slot, en una sola transacción. Úsala " +
        "solo después de que import_program devolvió 'slots_full' y el usuario " +
        "eligió explícitamente qué programa reemplazar. El borrado no se puede " +
        "deshacer.",
      inputSchema: {
        program: ProgramInputSchema,
        replace_program_id: z
          .uuid()
          .describe(
            "id del programa que el usuario eligió reemplazar (de la lista que devolvió import_program).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ program, replace_program_id }) => {
      const accessToken = resolveUserAccessToken();
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
              "Ese programa no existe o no es del usuario. Nada se borró ni se creó.",
          },
          true,
        );
      }

      if (error) return jsonResult({ error: error.message }, true);

      return jsonResult({ program_id: data, replaced_program_id: replace_program_id });
    },
  );
}
