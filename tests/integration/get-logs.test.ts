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

async function getLogs(args: Record<string, unknown> = {}) {
  const { data, error } = await user.db.rpc("get_logs", args);
  if (error) throw error;
  return data as {
    sessions: {
      id: string;
      date: string;
      program_name: string;
      measurements: Record<string, unknown>[];
      step_changes: Record<string, unknown>[];
      targets_met: string[];
    }[];
    next_cursor: Record<string, string> | null;
  };
}

const knee = (values: number[]) => ({ activity: ids.pushUps, step: ids.kneePushUps, values });
const full = (values: number[]) => ({ activity: ids.pushUps, step: ids.fullPushUps, values });
const rows = (values: number[]) => ({ activity: ids.rows, step: ids.rows.ladder_steps[0], values });

describe("get_logs", () => {
  test("returns sessions newest first with the previous get_logs fields", async () => {
    const older = await logSession(user.db, programId, ids, [knee([10])], { date: "2026-10-01", notes: "tired" });
    const newer = await logSession(user.db, programId, ids, [knee([11])], { date: "2026-10-03" });

    const { sessions, next_cursor } = await getLogs();

    expect(sessions.map((s) => s.id)).toEqual([newer, older]);
    expect(next_cursor).toBeNull();
    expect(sessions[1]).toMatchObject({
      program_id: programId,
      program_name: "Home calisthenics",
      session_slot_id: ids.slotId,
      session_slot_label: "Upper body",
      date: "2026-10-01",
      notes: "tired",
    });
    expect(sessions[1].measurements[0]).toEqual({
      activity: "Push-ups",
      activity_id: ids.pushUps.id,
      step: "Knee push-ups",
      step_id: ids.kneePushUps.id,
      target_sets: 3,
      in_plan: true,
      removed_from_plan: false,
      metric: "reps",
      value: 10,
      sequence: 1,
      extra: null,
    });
  });

  test("orders measurements by plan position, then set", async () => {
    await logSession(user.db, programId, ids, [rows([8, 9]), knee([10, 11])], {
      extras: [{ label: "Plank", metric: "seconds", values: [60] }],
    });

    const [session] = (await getLogs()).sessions;

    expect(session.measurements.map((m) => [m.activity, m.sequence, m.in_plan])).toEqual([
      ["Push-ups", 1, true],
      ["Push-ups", 2, true],
      ["Rows", 1, true],
      ["Rows", 2, true],
      ["Plank", 1, false],
    ]);
  });

  test("pages with a cursor without gaps or duplicates on the same date", async () => {
    const logged = [];
    for (let i = 0; i < 5; i++) {
      logged.push(await logSession(user.db, programId, ids, [knee([i])], { date: "2026-10-05" }));
    }

    const seen: string[] = [];
    let after: Record<string, string> | null = null;
    do {
      const page = await getLogs({ max_sessions: 2, after });
      seen.push(...page.sessions.map((s) => s.id));
      after = page.next_cursor;
    } while (after);

    expect(seen).toEqual(logged.reverse());
  });

  test("filters by program, session, activity and date", async () => {
    const first = await logSession(user.db, programId, ids, [knee([10]), rows([8])], { date: "2026-10-01" });
    const second = await logSession(user.db, programId, ids, [knee([11])], { date: "2026-10-02" });

    expect((await getLogs({ program_id: crypto.randomUUID() })).sessions).toEqual([]);
    expect((await getLogs({ session_log_id: first })).sessions.map((s) => s.id)).toEqual([first]);
    expect((await getLogs({ from_date: "2026-10-02" })).sessions.map((s) => s.id)).toEqual([second]);
    expect((await getLogs({ to_date: "2026-10-01" })).sessions.map((s) => s.id)).toEqual([first]);

    const byActivity = await getLogs({ activity_id: ids.rows.id });
    expect(byActivity.sessions.map((s) => s.id)).toEqual([first]);
    expect(byActivity.sessions[0].measurements.map((m) => m.activity)).toEqual(["Rows"]);
  });

  test("marks met targets and infers step changes between sessions", async () => {
    const advanced = await logSession(user.db, programId, ids, [knee([12, 12, 12])], { date: "2026-10-01" });
    const next = await logSession(user.db, programId, ids, [full([8, 8, 8])], { date: "2026-10-03" });

    const sessions = (await getLogs()).sessions;
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

    expect(byId[advanced].targets_met).toEqual([ids.kneePushUps.id]);
    expect(byId[advanced].step_changes).toEqual([]);
    expect(byId[next].targets_met).toEqual([]);
    expect(byId[next].step_changes).toEqual([
      {
        activity_id: ids.pushUps.id,
        from_step_id: ids.kneePushUps.id,
        from_step_label: "Knee push-ups",
        to_step_id: ids.fullPushUps.id,
        to_step_label: "Full push-ups",
        direction: "up",
      },
    ]);
  });

  test("keeps history of activities removed from the plan", async () => {
    await logSession(user.db, programId, ids, [rows([8])]);
    const { error } = await user.db.rpc("update_program", {
      program_id: programId,
      operations: [{ op: "remove_activity", activity_id: ids.rows.id }],
    });
    expect(error).toBeNull();

    const [session] = (await getLogs()).sessions;

    expect(session.measurements[0]).toMatchObject({
      activity: "Table rows",
      activity_id: null,
      in_plan: false,
      removed_from_plan: true,
    });
  });
});
