import { app, dialog, Notification } from 'electron';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import {
  createModelClient,
  resolveOpenAIRoute,
  runLoop,
  ScriptedModel,
  toolCatalog,
  type AgentTools,
  type ApprovalRequest,
  type ImageRef,
  type LoopOutcome,
  type MessageData,
  type ModelClient,
  type ModelRef,
  type SessionEvent,
  type ToolSpec,
} from '@wren/core';
import { runClaudeCode } from '../engines/claude-code';
import { runGrokBuild } from '../engines/grok-build';
import { deviceJson } from './api';
import { detect, type Capabilities } from './capabilities';
import * as chatgpt from './chatgpt';
import { loadDevice, loadPolicy, type Policy } from './config';
import { pendingAsks } from './asks';
import { closeRunTab, killRunJobs, LocalHost } from './host';
import { allowedRoots, isConfined } from './paths';
import { ProxyModelClient, RemoteStore } from './remote';

// Executes the user's runs that target this computer. Work arrives as a
// Realtime "wake" broadcast on this device's private channel (payload carries
// nothing sensitive) plus a heartbeat every minute as a fallback.

interface Claim {
  claimed: boolean;
  leaseId: string;
  run: { id: string; sessionId: string; step: number; maxSteps: number; model: ModelRef; trigger: string };
  agent: { id: string; name: string; autonomy: 'careful' | 'balanced' | 'autonomous'; tools: AgentTools; instructions: string };
  mcpTools: ToolSpec[];
  githubConnected: boolean;
}

interface Heartbeat {
  account?: { email?: string; name?: string };
  device: { id: string; name: string };
  settings: { openaiAccess: 'chatgpt' | 'api'; openaiAllowFallback: boolean; openaiKey?: boolean };
  work: { id: string; status: string; cancel: boolean; pause: boolean; leased: boolean }[];
}

export interface RunnerState {
  connected: boolean;
  running: number;
  lastError?: string;
  account?: { email?: string; name?: string };
  deviceName?: string;
  capabilities?: Capabilities;
}

export class DeviceRunner {
  private sb: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, AbortController>();
  /** Runs driven by a CLI engine (Claude Code, Grok Build). */
  private engineRuns = new Set<string>();
  /** Why a run was stopped by this app (not by the user), reported as its outcome. */
  private stopReasons = new Map<string, string>();
  private ticking = false;
  private again = false;
  /** Set while an update is being installed: no new work is picked up. */
  private suspended = false;
  state: RunnerState = { connected: false, running: 0 };

  constructor(
    private readonly onChange: () => void,
    private readonly onOpenTask: (sessionId: string) => void,
  ) {}

  start() {
    const d = loadDevice();
    if (!d) return;
    this.stop();
    this.sb = createClient(d.supabase.url, d.supabase.key, { auth: { persistSession: false, autoRefreshToken: false } });
    this.channel = this.sb
      .channel(d.channel, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'wake' }, () => {
        log('wake');
        void this.tick();
      })
      .subscribe((status, err) => {
        log(`realtime ${status}${err ? ` ${err.message}` : ''}`);
        this.state.connected = status === 'SUBSCRIBED';
        this.onChange();
        if (status === 'SUBSCRIBED') void this.tick();
      });
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.channel && this.sb) void this.sb.removeChannel(this.channel);
    this.channel = null;
    this.sb = null;
    this.state.connected = false;
  }

  abortAll() {
    for (const c of this.active.values()) c.abort();
  }

  /**
   * Stop taking work and stop every run, resolving once all of them have finished (their
   * outcomes reported) or false if that takes longer than `timeoutMs`. resume() undoes it.
   */
  async suspend(timeoutMs = 20_000): Promise<boolean> {
    this.suspended = true;
    this.stop();
    this.abortAll();
    const end = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return this.active.size === 0;
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.start();
  }

  async tick(): Promise<void> {
    if (this.suspended) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      const policy = loadPolicy();
      const caps = await detect(policy);
      this.state.capabilities = caps;
      const hb = await deviceJson<Heartbeat>('/api/device/heartbeat', {
        appVersion: app.getVersion(),
        capabilities: caps,
        policy: { folders: policy.folders, shell: policy.shell, browser: policy.browser, screen: policy.screen, remoteApprovals: policy.remoteApprovals },
      });
      this.state.account = hb.account;
      this.state.deviceName = hb.device.name;
      this.state.lastError = undefined;
      // With remote approvals off, approvals already waiting for this computer's runs become
      // approvable here only (each heartbeat, so it also happens after a failed attempt).
      if (!policy.remoteApprovals) await deviceJson('/api/device/approvals/local-only', {}).catch((e) => log(`local-only approvals: ${(e as Error).message}`));
      if (hb.work.length) log(`work: ${hb.work.map((w) => `${w.id.slice(0, 8)}:${w.status}${w.leased ? ':leased' : ''}`).join(', ')}`);
      for (const w of hb.work) {
        const running = this.active.get(w.id);
        if (running && w.cancel) running.abort();
        if (!running && !w.cancel && !this.suspended && this.active.size < 3 && (w.status === 'queued' || !w.leased)) void this.execute(w.id, hb.settings);
      }
    } catch (e) {
      this.state.lastError = (e as Error).message;
      log(`heartbeat failed: ${(e as Error).message}`);
      if ((e as { code?: string }).code === 'device_revoked') {
        this.stop();
      }
    } finally {
      this.ticking = false;
      this.onChange();
      if (this.again && !this.suspended) {
        this.again = false;
        void this.tick();
      }
    }
  }

  private async execute(runId: string, settings: Heartbeat['settings']) {
    const abort = new AbortController();
    this.active.set(runId, abort);
    this.state.running = this.active.size;
    this.onChange();
    let outcome: LoopOutcome = { kind: 'failed', error: 'The run could not start on this computer.', steps: 0 };
    let lease = '';
    let keepalive: ReturnType<typeof setInterval> | undefined;
    try {
      const c = await deviceJson<Claim>(`/api/device/runs/${runId}/claim`, {});
      if (!c.claimed) return;
      lease = c.leaseId;
      const policy = loadPolicy();
      const store = new RemoteStore(runId, lease);
      // Keep the lease while long actions run (shell commands, model calls) and
      // notice Stop/lease loss promptly; the loop also checks between actions.
      keepalive = setInterval(() => {
        store
          .control()
          .then((ctl) => ctl.cancel && abort.abort())
          .catch((e: { status?: number }) => e?.status === 409 && abort.abort());
      }, 45_000);
      store.localOnlyApprovals = () => !loadPolicy().remoteApprovals;
      store.onApproval = (id, req) => this.approvalPrompt(id, req, c, abort.signal);
      const model = c.run.model;
      if (model.source === 'claude-code' || model.source === 'grok-build') {
        this.engineRuns.add(runId);
        outcome = await this.runEngine(c, store, policy, abort.signal);
      } else {
        outcome = await this.runAgentLoop(c, store, policy, settings, abort.signal);
      }
    } catch (e) {
      log(`run ${runId.slice(0, 8)} crashed: ${(e as Error).stack ?? e}`);
      outcome = { kind: 'failed', error: (e as Error).message, steps: 0 };
    } finally {
      if (keepalive) clearInterval(keepalive);
      const stopped = this.stopReasons.get(runId);
      if (stopped) outcome = { kind: 'failed', error: stopped, code: 'permissions_changed', steps: outcome.steps };
      this.stopReasons.delete(runId);
      this.engineRuns.delete(runId);
      // A finished run's commands (background ones included) end with it.
      if (outcome.kind === 'completed' || outcome.kind === 'failed' || outcome.kind === 'cancelled') {
        killRunJobs(runId);
        void closeRunTab(runId);
      }
      log(`run ${runId.slice(0, 8)} -> ${outcome.kind}`);
      if (lease) await deviceJson(`/api/device/runs/${runId}/finish`, outcome, { lease }).catch(() => {});
      this.active.delete(runId);
      this.state.running = this.active.size;
      this.onChange();
    }
  }

  /** Checked against the folders allowed right now, not when the run started. */
  private inFolders() {
    return (p: string) => isConfined(p, allowedRoots(loadPolicy().folders));
  }

  /**
   * Settings took a permission away. Commands started under the old rules stop; a CLI engine
   * was sandboxed with the old folders when it started, so its run ends (the user can continue
   * it with a message). Agent-loop runs carry on: every action re-reads the new policy.
   */
  permissionsReduced() {
    for (const id of this.active.keys()) killRunJobs(id);
    for (const id of this.engineRuns) {
      this.stopReasons.set(id, 'Stopped because this computer’s permissions changed while it was running. Send a message to continue with the new settings.');
      this.active.get(id)?.abort();
    }
  }

  private async runEngine(c: Claim, store: RemoteStore, policy: Policy, signal: AbortSignal): Promise<LoopOutcome> {
    const events = await store.events();
    const seenSeq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    const asks = pendingAsks(events);
    const firstAsk = (asks[0]?.data ?? {}) as MessageData & { context?: string };
    const text = asks.map((e) => (e.data as MessageData).text ?? '').filter(Boolean).join('\n\n');
    const prompt = `${firstAsk.context ? `${firstAsk.context}\n\n` : ''}${text}`;
    const engine = c.run.model.source;
    // The engine's own session to continue (reasoning events also carry the follow-up cursor).
    const resume = [...events].reverse().find((e) => e.type === 'reasoning' && (e.data as { engine?: string }).engine === engine && typeof (e.data as { resumeId?: unknown }).resumeId === 'string') as SessionEvent<{ resumeId?: string }> | undefined;
    const run = {
      runId: c.run.id,
      store,
      agentName: c.agent.name,
      autonomy: c.agent.autonomy,
      instructions: c.agent.instructions.split('## Your instructions from the user\n')[1] ?? '',
      model: c.run.model.model,
      prompt,
      cwd: policy.folders[0],
      folders: policy.folders,
      // Getters: the switches are checked as they are now on every permission request.
      allow: {
        get shell() {
          return loadPolicy().shell;
        },
        get browser() {
          return loadPolicy().browser;
        },
        get screen() {
          return loadPolicy().screen;
        },
      },
      resumeId: resume?.data.resumeId,
      signal,
      saveResumeId: async (id: string) => {
        if (id !== resume?.data.resumeId) await store.append('reasoning', { engine, resumeId: id }, 'done');
      },
    };
    if (!policy.folders.length) return { kind: 'failed', error: 'No folders are allowed on this computer. Add one in Wren → Settings → This computer.', code: 'no_folders', steps: 0 };
    const inFolders = this.inFolders();
    const out = engine === 'claude-code' ? await runClaudeCode(run, inFolders, approveScript()) : await runGrokBuild(run, inFolders, approveScript().replace(/mcp-approve\.mjs$/, 'grok-hook.mjs'));
    if (out.kind !== 'completed') return out;
    // Everything up to seenSeq was given to the engine and answered: the next turn starts after it
    // (a follow-up sent while the engine worked comes before this answer, and must not be skipped).
    await store.append('reasoning', { engine, consumedSeq: seenSeq }, 'done');
    return { ...out, seenSeq };
  }

  private async runAgentLoop(c: Claim, store: RemoteStore, policy: Policy, settings: Heartbeat['settings'], signal: AbortSignal): Promise<LoopOutcome> {
    const ref = c.run.model;
    let model: ModelClient;
    let source = ref.source as string;
    const host = new LocalHost(loadPolicy, c.run.id, store.lease);
    // Models called directly from here need image bytes: screenshots from this run are cached,
    // anything else (uploads, earlier turns) comes from the server for this run's account.
    const loadImage = async (img: ImageRef) => {
      if (img.data) return { mime: img.mime, data: img.data };
      if (!img.artifactId) return null;
      const cached = host.imageCache.get(img.artifactId);
      if (cached) return cached;
      const r = await deviceJson<{ found: boolean; mime?: string; data?: string }>(`/api/device/runs/${c.run.id}/artifact`, { id: img.artifactId }, { lease: store.lease }).catch(() => null);
      if (!r?.found || !r.mime || !r.data) return null;
      const v = { mime: r.mime, data: r.data };
      host.imageCache.set(img.artifactId, v);
      return v;
    };
    if (source === 'openai' || source === 'chatgpt') {
      const st = chatgpt.status();
      const route = resolveOpenAIRoute({
        preference: source === 'chatgpt' ? 'chatgpt' : settings.openaiAccess,
        allowFallback: settings.openaiAllowFallback,
        runtime: 'desktop',
        chatgptAvailable: st.signedIn && !!st.planUsage,
        apiKeyAvailable: settings.openaiKey !== false,
      });
      if ('error' in route) return { kind: 'failed', error: route.error, code: 'no_credentials', steps: c.run.step };
      if (route.via === 'chatgpt') {
        model = createModelClient({ source: 'chatgpt', credential: () => chatgpt.accessToken(), loadImage });
        source = 'chatgpt';
      } else {
        model = new ProxyModelClient(c.run.id, store.lease, 'openai', ref.connectionId);
        source = 'openai';
      }
      if (route.note) await store.append('status', { text: route.note, level: 'info' }, 'done');
    } else if (source === 'local') {
      model = createModelClient({ source: 'local', baseUrl: policy.localModelUrl, loadImage });
    } else if (source === 'test') {
      model = new ScriptedModel();
    } else {
      model = new ProxyModelClient(c.run.id, store.lease, source, ref.connectionId);
    }
    store.usageSource = source;

    const tools = toolCatalog({ runtime: 'desktop', tools: c.agent.tools, githubConnected: c.githubConnected, extra: c.mcpTools }).filter((t) => {
      if (t.namespace === 'browser') return policy.browser;
      if (t.namespace === 'screen') return policy.screen;
      if (t.namespace === 'computer' && (t.name === 'shell' || t.name === 'shell_status')) return policy.shell;
      return true;
    });
    let step = c.run.step;
    let modelRetries = 0;
    for (;;) {
      const outcome = await runLoop({
        model,
        modelName: ref.model,
        source,
        effort: ref.effort,
        instructions: c.agent.instructions,
        tools,
        hosted: c.agent.tools.web && source !== 'local' && source !== 'test' ? [{ type: 'web_search' }] : [],
        runId: c.run.id,
        autonomy: c.agent.autonomy,
        store,
        host,
        deadline: Date.now() + 20 * 60_000,
        step,
        maxSteps: c.run.maxSteps,
        modelRetries,
        signal,
        log: (m, e) => console.log(`[run ${c.run.id.slice(0, 8)}] ${m}`, e ?? ''),
      });
      if (outcome.kind !== 'yield') return outcome;
      // The loop fails the run once the model provider has failed too many times in a row.
      modelRetries = outcome.retries ?? (outcome.steps > step ? 0 : modelRetries);
      step = outcome.steps;
      if (outcome.wakeInMs) {
        const ms = Math.min(outcome.wakeInMs, 120_000);
        await new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
      }
      if (signal.aborted) return { kind: 'cancelled', steps: step };
    }
  }

  /** Show approvals on this computer too; with remote approvals off, only a local answer counts. */
  private approvalPrompt(id: string, req: ApprovalRequest, c: Claim, signal: AbortSignal) {
    if (Notification.isSupported()) {
      const n = new Notification({ title: `${c.agent.name} needs your approval`, body: `${req.title}${req.reason ? ` — ${req.reason}` : ''}`, urgency: 'critical' });
      n.on('click', () => this.onOpenTask(c.run.sessionId));
      n.show();
    }
    if (loadPolicy().remoteApprovals) return;
    void dialog
      .showMessageBox({
        type: 'warning',
        title: 'Wren approval',
        message: `${c.agent.name} wants to: ${req.title}`,
        detail: `${req.reason ? `This ${req.reason}.\n\n` : ''}${typeof req.args.command === 'string' ? req.args.command : JSON.stringify(req.args, null, 2).slice(0, 800)}`,
        buttons: ['Deny', 'Approve'],
        defaultId: 0,
        cancelId: 0,
        signal,
      })
      .then((r) => deviceJson(`/api/device/runs/${c.run.id}/decide`, { id, approve: r.response === 1 }))
      .catch(() => {});
  }
}

function log(msg: string) {
  console.log(`[wren ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

let approvePath = '';
export function setApproveScript(p: string) {
  approvePath = p;
}
function approveScript() {
  return approvePath;
}
