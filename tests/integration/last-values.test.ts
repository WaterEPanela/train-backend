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

describe("last_values", () => {
  test("returns the latest session's values per step in set order", async () => {
    const rowsStep = ids.rows.ladder_steps[0];
    await logSession(user.db, programId, ids, [{ activity: ids.rows, step: rowsStep, values: [6, 7] }]);
    for (let i = 0; i < 3; i++) {
      await logSession(user.db, programId, ids, [{ activity: ids.pushUps, step: ids.kneePushUps, values: [9, 10 + i] }]);
    }

    const { data, error } = await user.db.rpc("last_values", {
      step_ids: [ids.kneePushUps.id, rowsStep.id, ids.fullPushUps.id],
    });

    expect(error).toBeNull();
    expect(data).toEqual({ [ids.kneePushUps.id]: [9, 12], [rowsStep.id]: [6, 7] });
  });
});
