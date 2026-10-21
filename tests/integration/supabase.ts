import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type LocalKeys = { url: string; anonKey: string; serviceRoleKey: string };

function localKeys(): LocalKeys {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY) {
    return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY };
  }

  const status = Bun.spawnSync(["supabase", "status", "-o", "json"]);
  if (status.exitCode !== 0) {
    throw new Error("Integration tests need the local stack: run `supabase start` first.");
  }
  const env = JSON.parse(status.stdout.toString());
  return { url: env.API_URL, anonKey: env.ANON_KEY, serviceRoleKey: env.SERVICE_ROLE_KEY };
}

const keys = localKeys();
const admin = createClient(keys.url, keys.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const createdUserIds: string[] = [];

export type TestUser = { id: string; db: SupabaseClient };

/** A fresh user signed in with the anon key, so every query goes through RLS like the MCP server's. */
export async function createTestUser(): Promise<TestUser> {
  const email = `test-${crypto.randomUUID()}@train.test`;
  const password = crypto.randomUUID();

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  const db = createClient(keys.url, keys.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await db.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;

  return { id: data.user.id, db };
}

/** Deletes the users created by this file; their programs and logs go with them (on delete cascade). */
export async function deleteTestUsers() {
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
}
