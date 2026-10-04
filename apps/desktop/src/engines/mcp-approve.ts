// Tiny stdio MCP server that Claude Code launches for --permission-prompt-tool.
// It forwards each permission prompt to the Wren desktop app (localhost, with a
// per-run token) and returns Wren's allow/deny decision.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const url = process.env.WREN_APPROVAL_URL!;
const token = process.env.WREN_APPROVAL_TOKEN!;

const server = new McpServer({ name: 'wren', version: '0.1.0' });
server.registerTool(
  'approve',
  {
    description: 'Ask Wren whether a tool call may run.',
    inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
  },
  async (args) => {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
      const decision = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(decision) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ behavior: 'deny', message: `Wren is not reachable: ${(e as Error).message}` }) }] };
    }
  },
);

await server.connect(new StdioServerTransport());
