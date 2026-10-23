import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestUser, deleteTestUsers, type TestUser } from "./supabase";
import { importProgram, logSession, programIds } from "../fixtures";

let user: TestUser;
let programId: string;
let ids: Awaited<ReturnType<typeof programIds>>;

beforeEach(async () => {
  user = await createTestUser();
  programId = await importProgram(user.db);
  ids = await programIds(user.db, programId);
});

afterAll(deleteTestUsers);

describe("delete_session_log", () => {
  test("removes the session and its measurements but keeps the step gained", async () => {
    const sessionId = await logSession(user.db, programId, ids, [
      { activity: ids.pushUps, step: ids.kneePushUps, values: [12, 12, 12] },
    ]);

    const { error } = await user.db.rpc("delete_session_log", { session_log_id: sessionId });

    expect(error).toBeNull();
    const { count } = await user.db.from("measurement_logs").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
    const { data } = await user.db.from("activities").select("current_step_id").eq("id", ids.pushUps.id).single();
    expect(data!.current_step_id).toBe(ids.fullPushUps.id);
  });

  test("fails with session_log_not_found for an unknown session", async () => {
    const { error } = await user.db.rpc("delete_session_log", { session_log_id: crypto.randomUUID() });
    expect(error?.message).toBe("session_log_not_found");
  });
});
