import { describe, expect, test } from "bun:test";

import { ProgramInputSchema } from "@/src/modules/mcp/schemas/program.schema";
import { sampleProgram } from "../fixtures";

// These rules are what the agent sees as JSON Schema errors, before any SQL runs.
describe("program input schema", () => {
  test("accepts a well-formed program", () => {
    expect(ProgramInputSchema.safeParse(sampleProgram()).success).toBe(true);
  });

  test("rejects a reps step without an exact number of sets", () => {
    const program = sampleProgram();
    delete program.phases[0].session_slots[0].activities[0].ladder[0].target_sets;

    const result = ProgramInputSchema.safeParse(program);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path.at(-1)).toBe("target_sets");
  });

  test("rejects a phase with only one of week_start / week_end", () => {
    const program = sampleProgram();
    delete program.phases[0].week_end;

    expect(ProgramInputSchema.safeParse(program).success).toBe(false);
  });
});
