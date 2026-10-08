// Tiny stdio MCP server that Claude Code launches for --permission-prompt-tool.
// It forwards each permission prompt to the Wren desktop app (localhost, with a
// per-run token) and returns Wren's allow/deny decision.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// The bridge's address and token come from Wren's private file (only this server's sandbox profile can
// read it), never from the command line or the environment, which other processes can read (W-121).
// Without it, every request is denied ("Wren is not reachable").
const { url, token } = (() => {
  try {
    return JSON.parse(readFileSync(process.env.WREN_APPROVAL_FILE ?? '', 'utf8')) as { url: string; token: string };
  } catch {
    return { url: '', token: '' };
  }
})();

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
