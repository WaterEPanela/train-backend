import { createClient } from "@supabase/supabase-js";

function supabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.local).",
    );
  }

  return { url, anonKey };
}

function createSupabaseClientForUser(accessToken: string) {
  const { url, anonKey } = supabaseEnv();

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function tokenClaim(token: string, claim: "exp" | "iat"): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const value = payload[claim];
    return typeof value === "number" ? value * 1000 : null;
  } catch {
    return null;
  }
}

let devSession: { token: string; expiresAt: number } | null = null;

async function signInDevUser(email: string, password: string) {
  if (devSession && devSession.expiresAt - 60_000 > Date.now()) {
    return devSession.token;
  }

  const { url, anonKey } = supabaseEnv();
  const auth = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    devSession = null;
    throw new Error(
      `Could not sign in the MCP dev user (MCP_DEV_EMAIL): ${error?.message ?? "no session"}.`,
    );
  }

  const issuedAt = tokenClaim(data.session.access_token, "iat");
  const wait = issuedAt === null ? 0 : issuedAt + 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  devSession = {
    token: data.session.access_token,
    expiresAt: (data.session.expires_at ?? 0) * 1000,
  };
  return devSession.token;
}

async function resolveUserAccessToken(): Promise<string> {
  const email = process.env.MCP_DEV_EMAIL;
  const password = process.env.MCP_DEV_PASSWORD;
  if (email && password) return signInDevUser(email, password);

  const token = process.env.MCP_DEV_USER_TOKEN;

  if (!token) {
    throw new Error(
      "Set MCP_DEV_EMAIL and MCP_DEV_PASSWORD (or MCP_DEV_USER_TOKEN) in .env.local.",
    );
  }

  const expiresAt = tokenClaim(token, "exp");
  if (expiresAt !== null && expiresAt <= Date.now()) {
    throw new Error(
      `MCP_DEV_USER_TOKEN expired on ${new Date(expiresAt).toISOString()}. ` +
        "Use MCP_DEV_EMAIL and MCP_DEV_PASSWORD instead so the server signs in by itself.",
    );
  }

  return token;
}

export async function getUserClient() {
  return createSupabaseClientForUser(await resolveUserAccessToken());
}
