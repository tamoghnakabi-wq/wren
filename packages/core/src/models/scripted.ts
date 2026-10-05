import { ModelError, type MessageData, type ModelClient, type ModelRequest, type ModelStreamEvent, type ModelTurn } from '../types';

// Deterministic model for automated end-to-end tests. The last user message
// carries a script:  #script [{"call":"computer.shell","args":{...}}, {"say":"done"}]
// Each model turn performs the next step; plain text ends the run.

// {"fail":"…"} simulates a provider outage (a retryable error) at that step.
type Step = { call?: string; args?: Record<string, unknown>; calls?: { call: string; args?: Record<string, unknown> }[]; say?: string; delayMs?: number; fail?: string };

export class ScriptedModel implements ModelClient {
  readonly label = 'test';

  async stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    let scriptAt = -1;
    for (let i = req.events.length - 1; i >= 0; i--) {
      const e = req.events[i];
      if (e.type === 'message' && (e.data as MessageData).role === 'user' && (e.data as MessageData).text.includes('#script')) {
        scriptAt = i;
        break;
      }
    }
    let steps: Step[] = [{ say: 'Hello from the test model.' }];
    if (scriptAt >= 0) {
      const text = (req.events[scriptAt].data as MessageData).text;
      try {
        steps = JSON.parse(text.slice(text.indexOf('#script') + 7).trim());
      } catch {
        steps = [{ say: 'Invalid #script JSON.' }];
      }
    }
    const done = req.events.slice(scriptAt + 1).filter((e) => e.type === 'message' && (e.data as MessageData).role === 'assistant' && e.status === 'done').length;
    const step = steps[Math.min(done, steps.length - 1)] ?? { say: 'Done.' };
    if (step.delayMs) await new Promise((r) => setTimeout(r, Math.min(step.delayMs!, 20000)));
    if (step.fail) throw new ModelError(`Scripted failure: ${step.fail}`, 503, 'test_failure', true);
    const calls = step.calls ?? (step.call ? [{ call: step.call, args: step.args }] : []);
    const text = step.say ?? '';
    for (const ch of text.match(/[\s\S]{1,12}/g) ?? []) onEvent({ type: 'text', delta: ch });
    const toolCalls = calls.map((c, i) => {
      const [namespace, ...rest] = c.call.split('.');
      return { callId: `t${done}_${i}_${Math.random().toString(36).slice(2, 7)}`, namespace, name: rest.join('.'), args: c.args ?? {} };
    });
    return {
      text,
      toolCalls,
      raw: { format: 'responses', items: [] },
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
      stopReason: toolCalls.length ? 'tool_calls' : 'end',
    };
  }
}
