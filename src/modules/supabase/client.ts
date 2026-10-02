import { createClient } from "@supabase/supabase-js";

export function createSupabaseClientForUser(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "SUPABASE_URL y SUPABASE_ANON_KEY deben estar definidas (ver .env.local).",
    );
  }

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export function resolveUserAccessToken(): string {
  const token = process.env.MCP_DEV_USER_TOKEN;

  if (!token) {
    throw new Error(
      "MCP_DEV_USER_TOKEN no está definido en .env.local (ver sección 'Camino gratis' de PLAN.md).",
    );
  }

  return token;
}
