import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertPublicUrl, guardedFetch } from '@wren/core/net';
import type { ToolSpec } from '@wren/core';

// Remote MCP servers (Streamable HTTP) as connected tools. Each server's tools
// are exposed to the model under its own namespace: mcp_<6 hex of conn id>.

export interface McpToolInfo {
  name: string;
  description?: string;
  readOnly?: boolean;
  inputSchema: Record<string, unknown>;
}

async function connect(url: string, token?: string) {
  await assertPublicUrl(url);
  const client = new Client({ name: 'wren', version: '0.1.0' });
  // guardedFetch re-checks the address on every connection (DNS can change after assertPublicUrl).
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: guardedFetch, requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } });
  await client.connect(transport);
  return client;
}

export async function probeMcp(url: string, token?: string): Promise<McpToolInfo[]> {
  const client = await connect(url, token);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.annotations?.readOnlyHint === true, inputSchema: t.inputSchema as Record<string, unknown> }));
  } finally {
    await client.close().catch(() => {});
  }
}

export function mcpNamespace(connectionId: string) {
  return `mcp_${connectionId.replace(/-/g, '').slice(0, 6)}`;
}

export function mcpToolSpecs(connectionId: string, label: string, tools: McpToolInfo[]): ToolSpec[] {
  const ns = mcpNamespace(connectionId);
  return tools.slice(0, 40).map((t) => ({
    namespace: ns,
    name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48),
    description: `[${label}] ${t.description ?? t.name}`.slice(0, 1000),
    parameters: { type: 'object', properties: {}, ...(t.inputSchema ?? {}) },
  }));
}

export async function callMcp(url: string, token: string | undefined, tool: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
  const client = await connect(url, token);
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    const parts = (r.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = parts.map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`)).join('\n');
    return { output: text || JSON.stringify(r.structuredContent ?? {}), isError: !!r.isError };
  } finally {
    await client.close().catch(() => {});
  }
}
