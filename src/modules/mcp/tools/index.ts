import type { McpServer } from "@modelcontextprotocol/server";
import { registerPingTool } from "./ping.tool";

export function registerAllTools(server: McpServer) {
  registerPingTool(server);
}
