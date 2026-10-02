import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createSupabaseClientForUser,
  resolveUserAccessToken,
} from "@/src/modules/supabase/client";

export function registerGetProgramTool(server: McpServer) {
  server.registerTool(
    "get_program",
    {
      title: "Get program",
      description:
        "Devuelve el programa más reciente del usuario autenticado, con su " +
        "estructura completa (fases, session_slots, activities, ladder_steps " +
        "y el current_step_id de cada activity). El usuario se deriva del " +
        "token de sesión — no se recibe ningún identificador por parámetro.",
      inputSchema: z.object({}),
    },
    async () => {
      const accessToken = resolveUserAccessToken();
      const supabase = createSupabaseClientForUser(accessToken);

      const { data, error } = await supabase
        .from("programs")
        .select(
          "*, phases(*, session_slots(*, activities(*, ladder_steps!ladder_steps_activity_id_fkey(*))))",
        )
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ error: error.message }) },
          ],
        };
      }

      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                program: null,
                message: "No hay ningún programa importado todavía.",
              }),
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ program: data }) }],
      };
    },
  );
}
