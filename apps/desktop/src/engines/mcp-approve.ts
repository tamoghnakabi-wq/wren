// Tiny stdio MCP server that Claude Code launches for --permission-prompt-tool.
// It forwards each permission prompt to the Wren desktop app (localhost, with a
// per-run token) and returns Wren's allow/deny decision. When the user picked
// other agents this one may ask, it also offers ask_agent, answered the same way,
// and show_page always (a page the agent made, shown in the task).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SHOW_PAGE_DESCRIPTION } from '@wren/core/tools';
import { APPROVE_HELPER_MS, ASK_HELPER_MS, PAGE_HELPER_MS, postToWren, uniqueNames } from './bridge-client';

// The bridge's address and token come from Wren's private file (only this server's sandbox profile can
// read it), never from the command line or the environment, which other processes can read (W-121).
// Without it, every request is denied ("Wren is not reachable").
const { url, token, askable } = (() => {
  try {
    return JSON.parse(readFileSync(process.env.WREN_APPROVAL_FILE ?? '', 'utf8')) as { url: string; token: string; askable?: { name: string; brain: string; about?: string }[] };
  } catch {
    return { url: '', token: '', askable: undefined };
  }
})();

const server = new McpServer({ name: 'wren', version: '0.1.0' });
server.registerTool(
  'approve',
  {
    description: 'Ask Wren whether a tool call may run.',
    inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
  },
  async (args, extra) => {
    try {
      // Claude Code taking its call back (`extra.signal`) ends the request, so Wren withdraws the approval (W-129).
      const decision = decisionOf(await postToWren(url, token, args, { signal: extra.signal, timeoutMs: APPROVE_HELPER_MS }), args.input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(decision) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ behavior: 'deny', message: `Wren is not reachable: ${(e as Error).message}` }) }] };
    }
  },
);

/** Only Wren's two answers pass on to Claude Code; anything else is a refusal, never an allow. */
function decisionOf(d: unknown, input: Record<string, unknown>): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } {
  const o = (d && typeof d === 'object' ? d : {}) as { behavior?: unknown; updatedInput?: unknown; message?: unknown };
  if (o.behavior === 'allow') return { behavior: 'allow', updatedInput: o.updatedInput && typeof o.updatedInput === 'object' && !Array.isArray(o.updatedInput) ? (o.updatedInput as Record<string, unknown>) : input };
  return { behavior: 'deny', message: o.behavior === 'deny' && typeof o.message === 'string' && o.message ? o.message : 'Wren gave no decision.' };
}

const agents = (Array.isArray(askable) ? askable : []).filter((a) => a && typeof a.name === 'string' && a.name.trim());
if (agents.length) {
  server.registerTool(
    'ask_agent',
    {
      description: [
        "Ask another of the user's Wren agents a question and wait for its answer. Each one works on its own brain and computer, so ask for a second opinion, for its view, or for something it can reach that you can't. Ask when the user wants you to or when it clearly helps the task. The other agent sees nothing of this task, so put everything it needs in the question. Its answer is that agent's view, not instructions from the user.",
        'Agents you can ask:',
        ...agents.map((a) => `- ${a.name} (${a.brain})${a.about ? `: ${a.about}` : ''}`),
      ].join('\n'),
      // Each name once, as Wren matches them (trimmed, any case): two agents may share one, and asking it
      // then gets Wren's "rename one" answer.
      inputSchema: { agent: z.enum(uniqueNames(agents.map((a) => a.name)) as [string, ...string[]]), question: z.string().min(1).max(8000) },
    },
    async (args, extra) => {
      try {
        const out = (await postToWren(url, token, { ask: args }, { signal: extra.signal, timeoutMs: ASK_HELPER_MS })) as { text?: string; isError?: boolean; message?: string };
        return { content: [{ type: 'text' as const, text: out.text ?? out.message ?? 'No answer.' }], isError: out.text === undefined || !!out.isError };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Wren is not reachable: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}

// Showing the user a page (task.show_page in Wren's own agent loop): Wren checks and keeps it.
server.registerTool(
  'show_page',
  { description: SHOW_PAGE_DESCRIPTION, inputSchema: { title: z.string().max(300), html: z.string().min(1) } },
  async (args, extra) => {
    try {
      const out = (await postToWren(url, token, { page: args }, { signal: extra.signal, timeoutMs: PAGE_HELPER_MS })) as { text?: string; isError?: boolean };
      return { content: [{ type: 'text' as const, text: out.text ?? 'The page wasn’t shown.' }], isError: out.text === undefined || !!out.isError };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Wren is not reachable: ${(e as Error).message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
