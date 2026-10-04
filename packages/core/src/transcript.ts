import type { ImageRef, MessageData, RawTurn, SessionEvent, ToolCallData } from './types';

// Converts the session's event log into a provider-neutral list of turns. Each
// adapter then renders these turns in its own wire format.

export interface NeutralCall {
  callId: string;
  namespace: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  isError: boolean;
  images: ImageRef[];
}

export type NeutralTurn =
  | { kind: 'user'; text: string; images: ImageRef[] }
  | { kind: 'assistant'; id: string; text: string; raw?: RawTurn; origin?: string; calls: NeutralCall[] };

const MISSING_RESULT = 'This tool call did not complete (it was cancelled or interrupted).';

export function splitName(qualifiedName: string): { namespace: string; name: string } {
  const i = qualifiedName.indexOf('.');
  return i < 0 ? { namespace: 'tools', name: qualifiedName } : { namespace: qualifiedName.slice(0, i), name: qualifiedName.slice(i + 1) };
}

export function buildTurns(events: SessionEvent[]): NeutralTurn[] {
  const turns: NeutralTurn[] = [];
  const byId = new Map<string, Extract<NeutralTurn, { kind: 'assistant' }>>();
  let lastAssistant: Extract<NeutralTurn, { kind: 'assistant' }> | undefined;

  for (const ev of events) {
    if (ev.type === 'message') {
      const d = ev.data as MessageData & { context?: string; answersCallId?: string };
      // Skip assistant messages that never completed and user answers already
      // delivered as an ask_user tool result.
      if (ev.status === 'failed' || ev.status === 'streaming') continue;
      if (d.role === 'user') {
        if (d.answersCallId) continue;
        const text = d.context ? `${d.context}\n\n${d.text ?? ''}` : d.text ?? '';
        turns.push({ kind: 'user', text, images: d.images ?? [] });
        lastAssistant = undefined;
      } else {
        const t: Extract<NeutralTurn, { kind: 'assistant' }> = {
          kind: 'assistant',
          id: ev.id,
          text: d.text ?? '',
          raw: d.raw,
          origin: d.source,
          calls: [],
        };
        turns.push(t);
        byId.set(ev.id, t);
        lastAssistant = t;
      }
    } else if (ev.type === 'tool') {
      const d = ev.data as ToolCallData;
      if (d.engine) continue; // display-only events from external CLI engines
      const owner = (d.turnId && byId.get(d.turnId)) || lastAssistant;
      if (!owner) continue;
      const { namespace, name } = splitName(d.name);
      const done = d.result !== undefined;
      owner.calls.push({
        callId: d.callId,
        namespace,
        name,
        args: d.args ?? {},
        output: done ? d.result!.output : ev.status === 'denied' ? 'The user denied this action.' : MISSING_RESULT,
        isError: done ? !!d.result!.isError : true,
        images: done ? d.result!.images ?? [] : [],
      });
    }
  }
  return turns;
}

/** Keep only the most recent `keep` images across the transcript (in place). */
export function limitImages(turns: NeutralTurn[], keep: number): void {
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const lists = t.kind === 'user' ? [t.images] : t.calls.map((c) => c.images);
    for (const list of lists) {
      for (let j = list.length - 1; j >= 0; j--) {
        if (seen >= keep) list.splice(j, 1);
        else seen++;
      }
    }
  }
}

/**
 * Trim old tool outputs to keep requests bounded (never used for Anthropic,
 * whose history must stay append-only so replayed thinking blocks stay valid).
 */
export function trimOutputs(turns: NeutralTurn[], opts = { recentFull: 14, recentChars: 24000, oldChars: 2000 }): void {
  let n = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.kind !== 'assistant') continue;
    for (let j = t.calls.length - 1; j >= 0; j--) {
      const c = t.calls[j];
      const limit = n < opts.recentFull ? opts.recentChars : opts.oldChars;
      if (c.output.length > limit) c.output = clipMiddle(c.output, limit);
      n++;
    }
  }
}

export function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head - 60;
  return `${s.slice(0, head)}\n…[${s.length - head - Math.max(0, tail)} characters omitted]…\n${tail > 0 ? s.slice(-tail) : ''}`;
}

export function flatName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

export function unflatName(flat: string): { namespace: string; name: string } {
  const i = flat.indexOf('__');
  return i < 0 ? { namespace: 'tools', name: flat } : { namespace: flat.slice(0, i), name: flat.slice(i + 2) };
}

export function parseArgs(raw: string | undefined): { args: Record<string, unknown>; error?: string } {
  if (!raw || !raw.trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
    return { args: {}, error: 'Tool arguments must be a JSON object.' };
  } catch (e) {
    return { args: {}, error: `Tool arguments were not valid JSON: ${(e as Error).message}` };
  }
}
