import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestUser, deleteTestUsers, type TestUser } from "./supabase";
import { getProgram, importProgram, programIds } from "../fixtures";

let user: TestUser;
let programId: string;

beforeEach(async () => {
  user = await createTestUser();
  programId = await importProgram(user.db);
});

afterAll(deleteTestUsers);

describe("update_program", () => {
  test("applies a batch and bumps the revision", async () => {
    const { rows } = await programIds(user.db, programId);

    const { data, error } = await user.db.rpc("update_program", {
      program_id: programId,
      expected_revision: 1,
      operations: [
        { op: "update_program_info", set: { name: "Renamed" } },
        { op: "update_activity", activity_id: rows.id, set: { rest_seconds: 90 } },
      ],
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ revision: 2, applied: 2 });
    expect(await getProgram(user.db, programId)).toEqual({ name: "Renamed", revision: 2 });
  });

  test("is all-or-nothing: one bad operation rolls back the ones before it", async () => {
    const { error } = await user.db.rpc("update_program", {
      program_id: programId,
      operations: [
        { op: "update_program_info", set: { name: "Should not stick" } },
        { op: "remove_activity", activity_id: crypto.randomUUID() },
      ],
    });

    expect(error?.message).toBe("not_found");
    expect(await getProgram(user.db, programId)).toEqual({ name: "Home calisthenics", revision: 1 });
  });

  test("rejects a stale expected_revision", async () => {
    const rename = (name: string, expected_revision: number) =>
      user.db.rpc("update_program", {
        program_id: programId,
        expected_revision,
        operations: [{ op: "update_program_info", set: { name } }],
      });

    expect((await rename("Edited in the app", 1)).error).toBeNull();

    const stale = await rename("Edited by the agent", 1);
    expect(stale.error?.message).toBe("revision_conflict");
    expect(await getProgram(user.db, programId)).toEqual({ name: "Edited in the app", revision: 2 });
  });

  test("refuses edits that leave the program inconsistent", async () => {
    const { pushUps, rows } = await programIds(user.db, programId);

    const { error } = await user.db.rpc("update_program", {
      program_id: programId,
      operations: [
        { op: "remove_activity", activity_id: pushUps.id },
        { op: "remove_activity", activity_id: rows.id },
      ],
    });

    expect(error?.message).toBe("invalid_program");
    expect(error?.details).toContain("needs at least one activity");
  });

  test("removing an activity keeps its logged history", async () => {
    const { slotId, pushUps, kneePushUps } = await programIds(user.db, programId);
    const logged = await user.db.rpc("log_session", {
      payload: {
        program_id: programId,
        session_slot_id: slotId,
        measurements: [{ activity_id: pushUps.id, step_id: kneePushUps.id, value: 10, sequence: 1 }],
      },
    });
    expect(logged.error).toBeNull();

    const removed = await user.db.rpc("update_program", {
      program_id: programId,
      operations: [{ op: "remove_activity", activity_id: pushUps.id }],
    });
    expect(removed.error).toBeNull();

    const { data: measurements } = await user.db
      .from("measurement_logs")
      .select("activity_id, step_id, adhoc_label, value, detached_at");
    expect(measurements).toHaveLength(1);
    expect(measurements![0]).toMatchObject({
      activity_id: null,
      step_id: null,
      adhoc_label: "Knee push-ups",
      value: 10,
    });
    expect(measurements![0].detached_at).not.toBeNull();
  });
});
