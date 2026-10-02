import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerPingTool(server: McpServer) {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Ping for connection",
      inputSchema: z.object({}),
    },
    async () => {
      return {
        content: [{ type: "text", text: JSON.stringify({ message: "pong" }) }],
      };
    },
  );
}
