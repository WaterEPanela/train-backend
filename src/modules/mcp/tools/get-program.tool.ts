import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";
import { getSlotSummary, jsonResult } from "@/src/modules/mcp/tools/program-slots";

export function registerGetProgramTool(server: McpServer) {
  server.registerTool(
    "get_program",
    {
      title: "Get program",
      description:
        "Devuelve un programa del usuario autenticado con su estructura " +
        "completa (fases, session_slots, activities, ladder_steps y el " +
        "current_step_id de cada activity; position indica el orden). Sin " +
        "program_id devuelve el más reciente. También devuelve la lista de " +
        "todos sus programas y cuántos slots usa, para elegir otro con program_id. " +
        "El usuario se deriva del token de sesión.",
      inputSchema: z.object({
        program_id: z
          .uuid()
          .optional()
          .describe("id de uno de los programas del usuario; por defecto el más reciente."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ program_id }) => {
      const accessToken = resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      let query = supabase
        .from("programs")
        .select(
          "*, phases(*, session_slots(*, activities(*, ladder_steps!ladder_steps_activity_id_fkey(*))))",
        );
      query = program_id
        ? query.eq("id", program_id)
        : query.order("created_at", { ascending: false }).limit(1);

      const [{ data, error }, summary] = await Promise.all([
        query.maybeSingle(),
        getSlotSummary(supabase),
      ]);

      if (error) return jsonResult({ error: error.message }, true);

      if (!data) {
        return jsonResult({
          program: null,
          message: program_id
            ? "Ese programa no existe o no es del usuario."
            : "No hay ningún programa importado todavía.",
          ...summary,
        });
      }

      return jsonResult({ program: data, ...summary });
    },
  );
}
