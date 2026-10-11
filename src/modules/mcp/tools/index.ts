import type { McpServer } from "@modelcontextprotocol/server";
import { registerPingTool } from "./ping.tool";
import { registerImportProgramTool } from "./import-program.tool";
import { registerGetProgramTool } from "./get-program.tool";
import { registerReplaceProgramTool } from "./replace-program.tool";

export function registerAllTools(server: McpServer) {
  registerPingTool(server);
  registerImportProgramTool(server);
  registerGetProgramTool(server);
  registerReplaceProgramTool(server);
}
