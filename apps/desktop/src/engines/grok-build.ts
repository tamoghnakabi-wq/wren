import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import type { LoopOutcome } from '@wren/core';
import { decide, findCli, spawnEngine, startApprovalBridge, stopEngine, TimelineWriter, type EngineRun } from './common';

// Grok Build engine: drives xAI's official `grok` CLI through its documented
// Agent Client Protocol mode (`grok agent stdio`), authenticated with the
// user's own cached login (`grok login`). Permission requests become Wren
// approvals; tool calls and messages stream into the task timeline.

interface RpcMsg {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
}

const KIND_TO_TOOL: Record<string, string> = { execute: 'computer.shell', edit: 'computer.edit_file', delete: 'computer.shell', move: 'computer.shell', read: 'computer.read_file', search: 'computer.list_files', fetch: 'web.fetch', think: 'task.update_plan', other: 'grok.tool' };

function toolFor(call: { kind?: string; title?: string; rawInput?: Record<string, unknown>; locations?: { path: string }[] }) {
  const kind = call.kind ?? 'other';
  const input = call.rawInput ?? {};
  const name = KIND_TO_TOOL[kind] ?? 'grok.tool';
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? (input.command as string[]).join(' ') : undefined;
  const args: Record<string, unknown> =
    name === 'computer.shell'
      ? { command: command ?? (kind === 'delete' ? `rm ${call.locations?.map((l) => l.path).join(' ') ?? ''}` : call.title ?? '') }
      : name === 'web.fetch'
        ? { url: String(input.url ?? call.title ?? '') }
        : { path: call.locations?.[0]?.path ?? String(input.path ?? input.file_path ?? '') };
  return { name, args, paths: (call.locations ?? []).map((l) => l.path).filter(Boolean) };
}

/** Grok tool names -> Wren policy names (for the PreToolUse hook). */
function mapGrokTool(name: string, input: Record<string, unknown>) {
  const n = name.toLowerCase();
  const path = String(input.path ?? input.file_path ?? input.absolute_path ?? input.target_file ?? '');
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? (input.command as string[]).join(' ') : '';
  if (/bash|terminal|shell|command|exec|run_/.test(n)) return { name: 'computer.shell', args: { command }, paths: [] as string[], title: `Run \`${command.slice(0, 120)}\`` };
  if (/delete|remove/.test(n)) return { name: 'computer.shell', args: { command: `rm ${path}` }, paths: path ? [path] : [], title: `Delete ${path}` };
  if (/edit|write|replace|create|move|rename|patch/.test(n)) return { name: 'computer.write_file', args: { path }, paths: path ? [path] : [], title: `Edit ${path}` };
  if (/read|view|cat|grep|glob|list|search|find|ls/.test(n)) return { name: 'computer.read_file', args: { path }, paths: path ? [path] : [], title: `${name} ${path}`.trim() };
  if (/fetch|web|browse|url|x_/.test(n)) return { name: 'web.fetch', args: { url: String(input.url ?? input.query ?? '') }, paths: [], title: `${name} ${String(input.url ?? input.query ?? '')}`.trim() };
  if (/mcp/.test(n)) return { name: `mcp_${name}`, args: input, paths: [], title: name };
  return { name: `grok.${name}`, args: input, paths: [], title: name };
}

export async function runGrokBuild(run: EngineRun, inFolders: (p: string) => boolean, hookScript: string): Promise<LoopOutcome> {
  const cli = findCli('grok');
  if (!cli) return { kind: 'failed', error: 'Grok Build isn’t installed on this computer. Install it (docs.x.ai/build), run `grok login` with your xAI account, then try again.', code: 'engine_missing', steps: 0 };

  const writer = new TimelineWriter(run.store, 'grok-build', run.model === 'default' ? 'Grok Build' : run.model);
  run.store.usageSource = 'grok-build';

  // Wren enforces its own approvals with a per-run plugin whose PreToolUse
  // hook asks Wren; Grok's own prompts are turned off for this process so a
  // personal "always-approve" setting can't bypass Wren's policy.
  const bridge = await startApprovalBridge(async ({ tool_name, input, tool_use_id }) => {
    const m = mapGrokTool(tool_name, input);
    if (m.name === 'computer.read_file' && !m.paths.length) return { allow: true };
    return decide(run, writer, { callId: tool_use_id ?? `hook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: m.name, args: m.args, title: m.title, paths: m.paths }, inFolders);
  });
  const pluginDir = join(tmpdir(), `wren-grok-${run.runId}`);
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wren-approvals', version: '0.1.0', description: 'Routes Grok tool calls through Wren approvals.' }));
  const hookCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
  writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookCmd, timeout: 3600 }] }] } }));

  const args = ['--no-auto-update', 'agent'];
  if (run.model && run.model !== 'default') args.push('-m', run.model);
  args.push('--always-approve', '--plugin-dir', pluginDir, 'stdio');
  const proc = await spawnEngine('grok-build', cli, args, run, hookScript, { ELECTRON_RUN_AS_NODE: '1', WREN_APPROVAL_URL: bridge.url, WREN_APPROVAL_TOKEN: bridge.token });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let steps = 0;
  const send = (m: RpcMsg) => proc.stdin.write(JSON.stringify(m) + '\n');
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });

  let chain = Promise.resolve();
  rl.on('line', (line) => {
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = pending.get(Number(msg.id));
      if (!p) return;
      pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? 'ACP error'));
      else p.resolve(msg.result ?? {});
      return;
    }
    chain = chain
      .then(async () => {
        if (msg.method === 'session/update') {
          const u = (msg.params?.update ?? {}) as Record<string, unknown>;
          const kind = u.sessionUpdate as string;
          if (kind === 'agent_message_chunk') {
            const c = u.content as { type?: string; text?: string };
            if (c?.type === 'text') await writer.textDelta(c.text ?? '');
          } else if (kind === 'tool_call') {
            steps++;
            const t = toolFor(u as never);
            await writer.toolStart(String(u.toolCallId), t.name, (u.rawInput as Record<string, unknown>) ?? t.args, String(u.title ?? t.name));
          } else if (kind === 'tool_call_update') {
            const status = u.status as string;
            if (status === 'completed' || status === 'failed') {
              const content = (u.content as { type: string; content?: { text?: string }; text?: string }[] | undefined) ?? [];
              const text = content.map((c) => c.content?.text ?? c.text ?? '').join('\n') || (typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput ?? ''));
              await writer.toolEnd(String(u.toolCallId), text, status === 'failed');
            }
          } else if (kind === 'plan') {
            const entries = (u.entries as { content: string; status: string }[]) ?? [];
            await run.store.append('plan', { items: entries.map((e) => ({ text: e.content, status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending' })) }, 'done');
          }
        } else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
          const p = msg.params ?? {};
          const call = (p.toolCall ?? {}) as { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown>; locations?: { path: string }[] };
          const options = (p.options ?? []) as { optionId: string; kind: string }[];
          const t = toolFor(call);
          const d = await decide(run, writer, { callId: String(call.toolCallId ?? `perm-${Date.now()}`), name: t.name, args: t.args, title: String(call.title ?? t.name), paths: t.paths }, inFolders);
          const opt = options.find((o) => o.kind === (d.allow ? 'allow_once' : 'reject_once')) ?? options.find((o) => (d.allow ? o.kind.startsWith('allow') : o.kind.startsWith('reject')));
          send({ jsonrpc: '2.0', id: msg.id, result: opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } } });
        } else if (msg.id !== undefined && msg.method) {
          // We don't offer client filesystem/terminal capabilities.
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Wren' } } as RpcMsg);
        }
      })
      .catch(() => {});
  });

  let sessionId = '';
  const onAbort = () => {
    if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    setTimeout(() => void stopEngine(proc), 3000);
  };
  run.signal.addEventListener('abort', onAbort, { once: true });
  const exited = new Promise<number>((r) => proc.on('close', (c) => r(c ?? 1)));

  try {
    const init = await Promise.race([request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'wren', title: 'Wren', version: '0.1.0' } }), exited.then(() => Promise.reject(new Error(stderr || 'grok exited')))]);
    const methods = new Set(((init.authMethods ?? []) as { id: string }[]).map((m) => m.id));
    if (!methods.has('cached_token')) throw new Error('Grok Build is not signed in. Run `grok login` in a terminal.');
    await request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    if (run.resumeId) {
      try {
        await request('session/load', { sessionId: run.resumeId, cwd: run.cwd, mcpServers: [] });
        sessionId = run.resumeId;
      } catch {
        sessionId = '';
      }
    }
    if (!sessionId) {
      const s = await request('session/new', { cwd: run.cwd, mcpServers: [] });
      sessionId = String(s.sessionId);
      await run.saveResumeId(sessionId);
    }
    const prompt = `${run.instructions ? `Instructions from the user for you as the agent "${run.agentName}": ${run.instructions}\n\n` : ''}${run.prompt}`;
    const res = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    await new Promise((r) => setTimeout(r, 300));
    await chain;
    const finalText = writer.currentText;
    await writer.endMessage();
    if (run.signal.aborted || res.stopReason === 'cancelled') return { kind: 'cancelled', steps };
    if (res.stopReason === 'refusal') return { kind: 'completed', result: 'Grok declined to continue this task.', steps };
    return { kind: 'completed', result: finalText || 'Done.', steps: steps || 1 };
  } catch (e) {
    await chain;
    await writer.endMessage();
    if (run.signal.aborted) return { kind: 'cancelled', steps };
    const msg = (e as Error).message;
    const hint = /login|auth|token|401/i.test(msg + stderr) ? ' Open a terminal and run `grok login` with your xAI account.' : '';
    return { kind: 'failed', error: `Grok Build: ${msg}${hint}`.slice(0, 1500), code: 'engine_error', steps };
  } finally {
    bridge.close();
    rmSync(pluginDir, { recursive: true, force: true });
    run.signal.removeEventListener('abort', onAbort);
    rl.close();
    proc.stdin.end();
    setTimeout(() => void stopEngine(proc), 1500);
  }
}
