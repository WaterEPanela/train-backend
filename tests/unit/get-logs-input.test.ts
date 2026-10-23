import { describe, expect, test } from "bun:test";

import { GetLogsInputSchema } from "@/src/modules/mcp/tools/get-logs.tool";

describe("get_logs input schema", () => {
  test("defaults to 20 sessions", () => {
    expect(GetLogsInputSchema.parse({})).toEqual({ limit: 20 });
  });

  test("rejects a limit above 100", () => {
    expect(GetLogsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  test("accepts the next_cursor returned by a previous call", () => {
    const cursor = { date: "2026-10-05", created_at: "2026-10-05T10:00:00.123456+00:00", id: crypto.randomUUID() };
    expect(GetLogsInputSchema.parse({ cursor }).cursor).toEqual(cursor);
  });

  test("rejects a malformed date", () => {
    expect(GetLogsInputSchema.safeParse({ from: "05/10/2026" }).success).toBe(false);
  });
});
