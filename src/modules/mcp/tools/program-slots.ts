import type { SupabaseClient } from "@supabase/supabase-js";

export type ToolResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
};

export function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/** The user's programs (each one fills a slot) and how many slots they have. */
export async function getSlotSummary(supabase: SupabaseClient) {
  const [programsResult, entitlementsResult] = await Promise.all([
    supabase
      .from("programs")
      .select("id, name, start_date, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("user_entitlements").select("program_slots").maybeSingle(),
  ]);

  if (programsResult.error) throw programsResult.error;
  if (entitlementsResult.error) throw entitlementsResult.error;

  // No entitlements row means the free tier: one slot.
  const slots = entitlementsResult.data?.program_slots ?? 1;
  return {
    slots,
    used: programsResult.data.length,
    programs: programsResult.data,
  };
}

/** Postgres errors raised by import_program / the slot trigger. */
export function isSlotsFullError(error: { message: string }) {
  return error.message === "slots_full";
}

export function isProgramNotFoundError(error: { message: string }) {
  return error.message === "program_not_found";
}
