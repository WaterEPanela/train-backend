import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestUser, deleteTestUsers, type TestUser } from "./supabase";
import { getProgram, importProgram, logSession, programIds, sampleProgram } from "../fixtures";

let owner: TestUser;
let other: TestUser;
let programId: string;

beforeAll(async () => {
  [owner, other] = await Promise.all([createTestUser(), createTestUser()]);
  programId = await importProgram(owner.db);
});

afterAll(deleteTestUsers);

describe("row level security", () => {
  test("another user cannot see the program", async () => {
    const { data } = await other.db.from("programs").select("id").eq("id", programId);
    expect(data).toEqual([]);
  });

  test("another user cannot edit, log against or replace the program", async () => {
    const { slotId } = await programIds(owner.db, programId);

    const results = await Promise.all([
      other.db.rpc("update_program", {
        program_id: programId,
        operations: [{ op: "update_program_info", set: { name: "Hijacked" } }],
      }),
      other.db.rpc("log_session", {
        payload: { program_id: programId, session_slot_id: slotId, measurements: [] },
      }),
      other.db.rpc("import_program", { payload: sampleProgram(), replace_program_id: programId }),
    ]);

    expect(results.map((r) => r.error?.message)).toEqual([
      "program_not_found",
      "program_not_found",
      "program_not_found",
    ]);
    expect(await getProgram(owner.db, programId)).toEqual({ name: "Home calisthenics", revision: 1 });
  });
});

describe("history", () => {
  test("another user cannot read or delete the owner's sessions", async () => {
    const ids = await programIds(owner.db, programId);
    const sessionId = await logSession(owner.db, programId, ids, [
      { activity: ids.rows, step: ids.rows.ladder_steps[0], values: [8] },
    ]);

    const logs = await other.db.rpc("get_logs", {});
    const deleted = await other.db.rpc("delete_session_log", { session_log_id: sessionId });
    const values = await other.db.rpc("last_values", { step_ids: [ids.rows.ladder_steps[0].id] });

    expect(logs.data).toEqual({ sessions: [], next_cursor: null });
    expect(deleted.error?.message).toBe("session_log_not_found");
    expect(values.data).toEqual({});
    const owned = await owner.db.rpc("get_logs", {});
    expect(owned.data.sessions.map((s: { id: string }) => s.id)).toEqual([sessionId]);
  });
});

describe("program slots", () => {
  test("a free account cannot import a second program", async () => {
    const { error } = await owner.db.rpc("import_program", { payload: sampleProgram("Second plan") });
    expect(error?.message).toBe("slots_full");
  });
});
