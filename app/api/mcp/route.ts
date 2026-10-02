import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/src/modules/mcp/tools";

const handler = createMcpHandler((server) => {
  registerAllTools(server);
});

export { handler as GET, handler as POST };
