import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { LoopOutcome } from '@wren/core';
import { decide, engineEnv, findCli, startApprovalBridge, TimelineWriter, type EngineRun } from './common';

// Claude Code engine: runs Anthropic's own, unmodified `claude` CLI on this
// computer, signed in by the user through Anthropic's login. Wren never sees
// Claude credentials; it streams the CLI's events into the task timeline and
// answers its permission prompts through a local MCP tool (mcp__wren__approve).

const TOOL_MAP: Record<string, (input: Record<string, unknown>) => { name: string; args: Record<string, unknown>; paths: string[] }> = {
  Bash: (i) => ({ name: 'computer.shell', args: { command: String(i.command ?? '') }, paths: [] }),
  Write: (i) => ({ name: 'computer.write_file', args: { path: String(i.file_path ?? '') }, paths: [String(i.file_path ?? '')] }),
  Edit: (i) => ({ name: 'computer.edit_file', args: { path: String(i.file_path ?? '') }, paths: [String(i.file_path ?? '')] }),
  MultiEdit: (i) => ({ name: 'computer.edit_file', args: { path: String(i.file_path ?? '') }, paths: [String(i.file_path ?? '')] }),
  NotebookEdit: (i) => ({ name: 'computer.edit_file', args: { path: String(i.notebook_path ?? '') }, paths: [String(i.notebook_path ?? '')] }),
  Read: (i) => ({ name: 'computer.read_file', args: { path: String(i.file_path ?? '') }, paths: [String(i.file_path ?? '')] }),
  Glob: (i) => ({ name: 'computer.list_files', args: { path: String(i.path ?? '.') }, paths: i.path ? [String(i.path)] : [] }),
  Grep: (i) => ({ name: 'computer.list_files', args: { path: String(i.path ?? '.') }, paths: i.path ? [String(i.path)] : [] }),
  WebFetch: (i) => ({ name: 'web.fetch', args: { url: String(i.url ?? '') }, paths: [] }),
  WebSearch: (i) => ({ name: 'web.fetch', args: { url: `search: ${String(i.query ?? '')}` }, paths: [] }),
};

function mapTool(name: string, input: Record<string, unknown>) {
  const m = TOOL_MAP[name];
  if (m) return m(input);
  return { name: name.startsWith('mcp__') ? `mcp_${name.slice(5)}` : `claude.${name}`, args: input, paths: [] as string[] };
}

function titleFor(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `Run \`${String(input.command ?? '').slice(0, 120)}\``;
    case 'Read':
      return `Read ${input.file_path}`;
    case 'Write':
      return `Write ${input.file_path}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${input.file_path}`;
    case 'Glob':
      return `Find ${input.pattern}`;
    case 'Grep':
      return `Search for ${String(input.pattern ?? '').slice(0, 60)}`;
    case 'WebFetch':
      return `Fetch ${input.url}`;
    case 'WebSearch':
      return `Search the web: ${String(input.query ?? '').slice(0, 80)}`;
    case 'TodoWrite':
      return 'Update plan';
    case 'Task':
    case 'Agent':
      return `Delegate: ${String(input.description ?? '').slice(0, 80)}`;
    default:
      return name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return JSON.stringify(content ?? '');
}

export async function runClaudeCode(run: EngineRun, inFolders: (p: string) => boolean, approveScript: string): Promise<LoopOutcome> {
  const cli = findCli('claude');
  if (!cli) return { kind: 'failed', error: 'Claude Code isn’t installed on this computer. Install it (code.claude.com), run `claude` once and sign in with your Claude account, then try again.', code: 'engine_missing', steps: 0 };

  const writer = new TimelineWriter(run.store, 'claude-code', run.model === 'default' ? 'Claude Code' : run.model);
  run.store.usageSource = 'claude-code';

  // Local endpoint the MCP approval tool calls back into.
  const bridge = await startApprovalBridge(async ({ tool_name, input, tool_use_id }) => {
    const m = mapTool(tool_name, input);
    return decide(run, writer, { callId: tool_use_id ?? `perm-${Date.now()}`, name: m.name, args: m.args, title: titleFor(tool_name, input), paths: m.paths.filter(Boolean) }, inFolders);
  });

  const mcpConfig = {
    mcpServers: {
      wren: {
        command: process.execPath,
        args: [approveScript],
        env: { ELECTRON_RUN_AS_NODE: '1', WREN_APPROVAL_URL: bridge.url, WREN_APPROVAL_TOKEN: bridge.token },
      },
    },
  };
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'mcp__wren__approve',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--append-system-prompt',
    `You are working for the user through Wren as the agent "${run.agentName}". ${run.instructions}`.slice(0, 20000),
  ];
  if (run.model && run.model !== 'default') args.push('--model', run.model);
  for (const f of run.folders.slice(1)) args.push('--add-dir', f);
  if (run.resumeId) args.push('--resume', run.resumeId);

  const proc = spawn(cli, args, { cwd: run.cwd, env: engineEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: run.prompt } }) + '\n');
  const onAbort = () => proc.kill('SIGTERM');
  run.signal.addEventListener('abort', onAbort, { once: true });

  let stderr = '';
  proc.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
  let result: { subtype?: string; result?: string; is_error?: boolean; num_turns?: number; usage?: Record<string, number> } | null = null;
  let buf = '';
  let chain = Promise.resolve();
  const handle = async (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const type = ev.type as string;
    if (type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
      await run.saveResumeId(ev.session_id);
    } else if (type === 'stream_event') {
      const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !ev.parent_tool_use_id) await writer.textDelta(e.delta.text ?? '');
    } else if (type === 'assistant' && !ev.parent_tool_use_id) {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      for (const b of content) {
        if (b.type === 'text' && b.text && !writer.currentText) await writer.textDelta(b.text);
        if (b.type === 'tool_use' && b.id && b.name) {
          if (writer.tools.has(b.id)) continue;
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            const items = (b.input!.todos as { content: string; status: string }[]).map((t) => ({ text: t.content, status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending' }));
            await run.store.append('plan', { items }, 'done');
          }
          const m = mapTool(b.name, b.input ?? {});
          await writer.toolStart(b.id, m.name, b.input ?? {}, titleFor(b.name, b.input ?? {}));
        }
      }
    } else if (type === 'user' && !ev.parent_tool_use_id) {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[];
      for (const b of content) if (b.type === 'tool_result' && b.tool_use_id) await writer.toolEnd(b.tool_use_id, resultText(b.content), !!b.is_error);
    } else if (type === 'result') {
      result = ev as typeof result;
      proc.stdin.end();
    }
  };
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) chain = chain.then(() => handle(line)).catch(() => {});
    }
  });

  const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 1)));
  await chain;
  bridge.close();
  run.signal.removeEventListener('abort', onAbort);
  const r = result as { subtype?: string; result?: string; is_error?: boolean; num_turns?: number; usage?: Record<string, number> } | null;
  if (r?.usage) {
    await run.store
      .recordUsage({ inputTokens: (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0), outputTokens: r.usage.output_tokens ?? 0, cachedTokens: r.usage.cache_read_input_tokens ?? 0 }, run.model === 'default' ? 'claude-code' : run.model)
      .catch(() => {});
  }
  if (run.signal.aborted) {
    await writer.endMessage();
    return { kind: 'cancelled', steps: r?.num_turns ?? 0 };
  }
  if (r && !r.is_error && r.subtype === 'success') {
    const finalText = writer.currentText || r.result || '';
    await writer.endMessage(finalText);
    return { kind: 'completed', result: r.result || finalText, steps: r.num_turns ?? 1 };
  }
  await writer.endMessage();
  const err = r?.result || stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}.`;
  const hint = /log ?in|authenticat|credential|401|not logged/i.test(err) ? ' Open a terminal, run `claude`, and sign in with your Claude account.' : '';
  return { kind: 'failed', error: `Claude Code: ${err}${hint}`.slice(0, 1500), code: 'engine_error', steps: r?.num_turns ?? 0 };
}

export const APPROVE_SCRIPT_NAME = 'mcp-approve.mjs';
// Unpacked from app.asar so Claude Code can launch it with Electron's Node.
export const approveScriptPath = (distDir: string) => join(distDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1').replace(/app\.asar$/, 'app.asar.unpacked'), APPROVE_SCRIPT_NAME);
