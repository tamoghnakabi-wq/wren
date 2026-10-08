import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopOutcome } from '@wren/core';
import { dataDir } from '../main/config';
import { allowedRoots } from '../main/paths';
import { approvalServerProfile, hasSeatbelt } from '../main/sandbox';
import { appPaths, claudeSupportsRestricted, decide, findCli, finishEngine, spawnClaude, startApprovalBridge, stopEngine, TimelineWriter, type EngineRun } from './common';

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

/**
 * Built-in tools a Wren agent gets in Claude Code (restricted mode removes Bash and WebFetch unless named).
 * Its to-do list was TodoWrite; newer versions (2.1.2xx) replaced it with TaskCreate/TaskUpdate/TaskList/TaskGet.
 * Names a version doesn't have are ignored, so both are listed.
 */
const CLAUDE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,NotebookEdit,WebFetch,WebSearch,TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet,Task';
/** Claude Code's own to-do list: shown as the task's plan, not as steps. */
const PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

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

type PlanResult = {
  success?: boolean;
  task?: { id?: unknown; subject?: unknown; status?: unknown };
  tasks?: { id?: unknown; subject?: unknown; status?: unknown }[];
};

/**
 * Apply a finished task-list call to the plan; true when it changed. TaskCreate adds what it made; TaskUpdate
 * applies only when Claude Code says it succeeded (a missing task answers success: false, not an error);
 * TaskList replaces the plan with Claude Code's own list, TaskGet refreshes one item (shapes from 2.1.294).
 */
export function applyPlanResult(todo: Map<string, { text: string; status: string }>, call: { name: string; input: Record<string, unknown> }, out: PlanResult | undefined, text: string): boolean {
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
  const put = (t: { id?: unknown; subject?: unknown; status?: unknown }) => {
    const id = str(t.id);
    if (!id) return false;
    const prev = todo.get(id);
    todo.set(id, { text: str(t.subject) ?? prev?.text ?? `Task ${id}`, status: str(t.status) ?? prev?.status ?? 'pending' });
    return true;
  };
  switch (call.name) {
    case 'TaskCreate': {
      const id = str(out?.task?.id) ?? /Task #(\w+) created/.exec(text)?.[1];
      return id ? put({ id, subject: call.input.subject ?? call.input.description, status: 'pending' }) : false;
    }
    case 'TaskUpdate': {
      const id = str(call.input.taskId);
      if (out?.success !== true || !id) return false;
      if (call.input.status === 'deleted') return todo.delete(id);
      return put({ id, subject: call.input.subject, status: call.input.status });
    }
    case 'TaskList': {
      if (!Array.isArray(out?.tasks)) return false;
      todo.clear();
      for (const t of out.tasks) put(t);
      return true;
    }
    case 'TaskGet':
      return out?.task ? put(out.task) : false;
  }
  return false;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return JSON.stringify(content ?? '');
}

export async function runClaudeCode(run: EngineRun, inFolders: (p: string) => boolean, approveScript: string): Promise<LoopOutcome> {
  const cli = findCli('claude');
  if (!cli) return { kind: 'failed', error: 'Claude Code isn’t installed on this computer. Install it (code.claude.com), run `claude` once and sign in with your Claude account, then try again.', code: 'engine_missing', steps: 0 };
  if (!claudeSupportsRestricted(cli)) return { kind: 'failed', error: 'This version of Claude Code is too old for Wren. Update it (run `claude update` in Terminal), then try again.', code: 'engine_outdated', steps: 0 };

  const writer = new TimelineWriter(run.store, 'claude-code', run.model === 'default' ? 'Claude Code' : run.model);
  run.store.usageSource = 'claude-code';

  // Local endpoint the MCP approval tool calls back into.
  const bridge = await startApprovalBridge(async ({ tool_name, input, tool_use_id, signal }) => {
    const m = mapTool(tool_name, input);
    return decide(run, writer, { callId: tool_use_id ?? `perm-${Date.now()}`, name: m.name, args: m.args, title: titleFor(tool_name, input), paths: m.paths.filter(Boolean) }, inFolders, signal);
  });

  // Everything acquired from here on (the bridge, the private folder, the CLI and its Stop handler) is
  // released in the finally, each step on its own, so one failing can't skip the others (W-131).
  const privateDir = join(dataDir(), 'approvals', run.runId);
  let spawned: ChildProcess | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    // The bridge's address and token stay in a private folder of Wren's data folder, which commands can't
    // read: not on Claude Code's command line or in any environment, which other processes can read (W-121).
    // The approval server gets a sandbox profile that can read that folder (see SHELL_PREFIX).
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const approvalFile = join(privateDir, 'approval.json');
    writeFileSync(approvalFile, JSON.stringify({ url: bridge.url, token: bridge.token }), { mode: 0o600 });
    const serverEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', WREN_APPROVAL_FILE: approvalFile };
    if (hasSeatbelt()) serverEnv.WREN_APPROVAL_SB = approvalServerProfile(allowedRoots(run.folders), dataDir(), appPaths(approveScript), privateDir);
    const mcpFile = join(privateDir, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { wren: { command: process.execPath, args: [approveScript], env: serverEnv } } }), { mode: 0o600 });
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
      // Restricted: the user's own settings files (allow rules, hooks) don't apply and the file tools
      // stay inside the working folders; only Wren's MCP server is loaded.
      '--restricted',
      '--tools',
      CLAUDE_TOOLS,
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile,
      '--append-system-prompt',
      `You are working for the user through Wren as the agent "${run.agentName}". ${run.instructions}`.slice(0, 20000),
    ];
    if (run.model && run.model !== 'default') args.push('--model', run.model);
    for (const f of run.folders.slice(1)) args.push('--add-dir', f);
    if (run.resumeId) args.push('--resume', run.resumeId);

    if (run.signal.aborted) {
      return { kind: 'cancelled', steps: 0 };
    }
    const proc = await spawnClaude(cli, args, run, approveScript);
    spawned = proc;
    // Watch for Stop before Claude Code gets the prompt; a Stop that came meanwhile stops it at once (W-122).
    const onAbort = () => void stopEngine(proc);
    abortHandler = onAbort;
    run.signal.addEventListener('abort', onAbort, { once: true });
    if (run.signal.aborted) onAbort();
    // Attached images go in the same message, as Anthropic image blocks (stream-json input, checked with 2.1.294).
    const content = run.images?.length
      ? [{ type: 'text', text: run.prompt }, ...run.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))]
      : run.prompt;
    if (!run.signal.aborted) proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

    let stderr = '';
    proc.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
    // The to-do list from TaskCreate/TaskUpdate, in creation order, becomes the plan panel.
    // A follow-up continues the session's list: start from the plan the last turn left.
    const todo = new Map<string, { text: string; status: string }>(
      (run.plan ?? []).filter((p) => p.id).map((p) => [p.id!, { text: p.text, status: p.status === 'done' ? 'completed' : p.status }]),
    );
    // Task-list calls waiting for their result: the plan changes only on what Claude Code reports done (W-127).
    const planCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
    const showPlan = () =>
      run.store.append('plan', { items: [...todo].map(([id, t]) => ({ id, text: t.text, status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending' })) }, 'done');
    let result: { subtype?: string; result?: string; is_error?: boolean; num_turns?: number; usage?: Record<string, number> } | null = null;
    // A background sub-agent makes the CLI answer twice in one run (a result, then another turn and
    // result when the sub-agent reports back): count every turn's usage, keep the last answer.
    const usage: Record<string, number> = {};
    let turns = 0;
    let savedSession = run.resumeId;
    let turnText = false; // this turn's answer has been written (streamed)
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
        // Each turn starts with one; the session is the same.
        if (ev.session_id !== savedSession) {
          savedSession = ev.session_id;
          await run.saveResumeId(ev.session_id);
        }
      } else if (type === 'stream_event') {
        const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !ev.parent_tool_use_id && e.delta.text) {
          turnText = true;
          await writer.textDelta(e.delta.text);
        }
      } else if (type === 'assistant' && !ev.parent_tool_use_id) {
        const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
        for (const b of content) {
          if (b.type === 'text' && b.text && !writer.currentText) {
            turnText = true;
            await writer.textDelta(b.text);
          }
          if (b.type === 'tool_use' && b.id && b.name && PLAN_TOOLS.has(b.name)) {
            await writer.endMessage(); // text before and after it stays two messages, as with any tool
            planCalls.set(b.id, { name: b.name, input: b.input ?? {} });
            continue;
          }
          if (b.type === 'tool_use' && b.id && b.name) {
            if (writer.tools.has(b.id)) {
            await writer.endMessage(); // its permission prompt made the step first; the message still ends here (W-132)
            continue;
          }
            if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
              const items = (b.input!.todos as { content: string; status: string }[]).map((t) => ({ text: t.content, status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending' }));
              await run.store.append('plan', { items }, 'done');
            }
            const m = mapTool(b.name, b.input ?? {});
            await writer.toolStart(b.id, m.name, b.input ?? {}, titleFor(b.name, b.input ?? {}));
          }
        }
      } else if (type === 'user') {
        // Sub-agents' results too (parent_tool_use_id set): their calls that needed approval have a step
        // (from the permission prompt) that ends here. The writer ignores ids it has no step for.
        const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[];
        for (const b of content) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const call = planCalls.get(b.tool_use_id);
          if (call) {
            planCalls.delete(b.tool_use_id);
            if (!b.is_error && applyPlanResult(todo, call, ev.tool_use_result as PlanResult | undefined, resultText(b.content))) await showPlan();
            continue;
          }
          await writer.toolEnd(b.tool_use_id, resultText(b.content), !!b.is_error);
        }
      } else if (type === 'result') {
        result = ev as typeof result;
        for (const [k, v] of Object.entries(result?.usage ?? {})) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
        turns += result?.num_turns ?? 0;
        // Each turn's answer is its own message (a sub-agent reporting back starts another turn); one
        // that wasn't streamed comes from the result.
        const answer = result && !result.is_error && result.subtype === 'success' && !turnText ? (result.result ?? '') : undefined;
        await writer.endMessage(answer);
        turnText = false;
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
    const r = result as { subtype?: string; result?: string; is_error?: boolean; num_turns?: number; usage?: Record<string, number> } | null;
    if (r) {
      await run.store
        .recordUsage({ inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cachedTokens: usage.cache_read_input_tokens ?? 0 }, run.model === 'default' ? 'claude-code' : run.model)
        .catch(() => {});
    }
    if (run.signal.aborted) {
      await writer.endMessage();
      return { kind: 'cancelled', steps: turns };
    }
    if (r && !r.is_error && r.subtype === 'success') {
      await writer.endMessage();
      return { kind: 'completed', result: r.result || 'Done.', steps: turns || 1 };
    }
    await writer.endMessage();
    const err = r?.result || stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}.`;
    const hint = /log ?in|authenticat|credential|401|not logged/i.test(err) ? ' Open a terminal, run `claude`, and sign in with your Claude account.' : '';
    return { kind: 'failed', error: `Claude Code: ${err}${hint}`.slice(0, 1500), code: 'engine_error', steps: turns };
  } finally {
    const attempt = (f: () => void) => {
      try {
        f();
      } catch {
        /* the others still run */
      }
    };
    attempt(() => bridge.close());
    attempt(() => rmSync(privateDir, { recursive: true, force: true }));
    if (abortHandler) run.signal.removeEventListener('abort', abortHandler);
    // Claude Code has exited (or never started): anything it left running ends with the turn.
    if (spawned) await finishEngine(spawned, writer).catch(() => {});
  }
}

export const APPROVE_SCRIPT_NAME = 'mcp-approve.mjs';
// Unpacked from app.asar so Claude Code can launch it with Electron's Node.
export const approveScriptPath = (distDir: string) => join(distDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1').replace(/app\.asar$/, 'app.asar.unpacked'), APPROVE_SCRIPT_NAME);
