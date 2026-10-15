import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestUser, deleteTestUsers, type TestUser } from "./helpers/supabase";
import { importProgram, programIds } from "./helpers/fixtures";

let user: TestUser;
let programId: string;
let ids: Awaited<ReturnType<typeof programIds>>;

beforeEach(async () => {
  user = await createTestUser();
  programId = await importProgram(user.db);
  ids = await programIds(user.db, programId);
});

afterAll(deleteTestUsers);

function logPushUps(reps: number[], client_id?: string) {
  return user.db.rpc("log_session", {
    payload: {
      program_id: programId,
      session_slot_id: ids.slotId,
      client_id,
      measurements: reps.map((value, i) => ({
        activity_id: ids.pushUps.id,
        step_id: ids.kneePushUps.id,
        value,
        sequence: i + 1,
      })),
    },
  });
}

async function currentPushUpStep() {
  const { data } = await user.db.from("activities").select("current_step_id").eq("id", ids.pushUps.id).single();
  return data!.current_step_id;
}

// Rule under test: "all sets >= 12" with target_sets = 3.
describe("log_session progression", () => {
  test("advances to the next ladder step when the rule is met", async () => {
    const { data, error } = await logPushUps([12, 12, 13]);

    expect(error).toBeNull();
    expect(data.progressions).toEqual([
      {
        activity_id: ids.pushUps.id,
        from_step_id: ids.kneePushUps.id,
        to_step_id: ids.fullPushUps.id,
        to_step_label: "Full push-ups",
      },
    ]);
    expect(await currentPushUpStep()).toBe(ids.fullPushUps.id);
  });

  test.each([
    ["one set falls short", [12, 12, 11]],
    ["fewer sets than target_sets", [12, 12]],
  ])("stays on the same step when %s", async (_, reps) => {
    const { data, error } = await logPushUps(reps);

    expect(error).toBeNull();
    expect(data.progressions).toEqual([]);
    expect(await currentPushUpStep()).toBe(ids.kneePushUps.id);
  });

  test("a retried call with the same client_id is not logged twice", async () => {
    const clientId = crypto.randomUUID();
    const first = await logPushUps([12, 12, 12], clientId);
    const retry = await logPushUps([12, 12, 12], clientId);

    expect(retry.data).toMatchObject({ session_log_id: first.data.session_log_id, duplicate: true });
    const { count } = await user.db.from("session_logs").select("*", { count: "exact", head: true });
    expect(count).toBe(1);
  });
});
