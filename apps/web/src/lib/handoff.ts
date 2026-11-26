// Carrying a task on with another agent (POST /api/sessions/:id/handoff): the new agent starts a task of its
// own with the old task's conversation in its context, as text. Each agent keeps its own way of working (its
// brain, its computer, its CLI's session), so what passes is what was said and done, not the old agent's state.
// Pure, so it is tested on its own (test/handoff.test.ts).

/** The most of the old conversation the new agent is given (about 12,000 tokens). */
export const HANDOFF_MAX_CHARS = 48_000;
/** How much of the task's first message is always kept, however long the rest is. */
const FIRST_MAX_CHARS = 6_000;

interface EventLike {
  type: string;
  status?: string | null;
  data: Record<string, unknown>;
}

const ATTACHED = /\n\n\[Attached files: [^\n]*\]$/;
/** Text that could pose as the context block's own markup is taken apart. */
const clean = (s: string) => s.replace(/<\/?\s*(context|earlier-conversation)\b[^>]*>/gi, '[tag removed]').trim();

/** One line (or block) per message and step, in order; the latest plan last. */
export function handoffLines(events: EventLike[], agentName: string): string[] {
  const lines: string[] = [];
  type PlanItem = { text?: unknown; status?: unknown };
  let plan: PlanItem[] | null = null;
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'message') {
      if (e.status === 'failed' || e.status === 'streaming') continue;
      const text = clean(String(d.text ?? '').replace(ATTACHED, ''));
      if (d.role === 'user') {
        const files = Array.isArray(d.attachments) ? (d.attachments as { name?: unknown }[]).map((a) => String(a?.name ?? '')).filter(Boolean) : [];
        const label = d.answersCallId ? 'User (answering)' : 'User';
        lines.push(`${label}: ${text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}`);
      } else if (text) {
        lines.push(`${agentName}: ${text}`);
      }
    } else if (e.type === 'tool') {
      const name = String(d.name ?? '');
      if (name === 'task.update_plan') continue;
      const result = d.result as { isError?: unknown } | undefined;
      const how = e.status === 'denied' ? ' (the user said no)' : e.status === 'cancelled' ? ' (stopped)' : e.status === 'error' || result?.isError === true ? ' (failed)' : '';
      lines.push(`  - ${clean(String(d.title ?? name)).replace(/\s+/g, ' ').slice(0, 300)}${how}`);
    } else if (e.type === 'status') {
      const text = clean(String(d.text ?? ''));
      if (text) lines.push(`[${text.replace(/\s+/g, ' ').slice(0, 400)}]`);
    } else if (e.type === 'plan' && Array.isArray(d.items)) {
      plan = d.items as PlanItem[];
    }
  }
  if (plan?.length) {
    const mark = (s: unknown) => (s === 'done' ? 'x' : s === 'in_progress' ? '~' : ' ');
    lines.push(['Plan when it stopped:', ...plan.map((i) => `- [${mark(i.status)}] ${clean(String(i.text ?? '')).slice(0, 300)}`)].join('\n'));
  }
  return lines;
}

/**
 * The conversation as the new agent is given it, within `max` characters: the first message (the task as
 * asked) always, then as much of the latest part as fits, with a note where the middle was left out.
 */
export function handoffTranscript(events: EventLike[], agentName: string, max = HANDOFF_MAX_CHARS): string {
  const lines = handoffLines(events, agentName);
  const all = lines.join('\n');
  if (all.length <= max) return all;
  const first = lines[0].length > FIRST_MAX_CHARS ? `${lines[0].slice(0, FIRST_MAX_CHARS)} […]` : lines[0];
  const tail: string[] = [];
  let used = first.length + 80;
  for (let i = lines.length - 1; i > 0; i--) {
    const l = lines[i].length > max / 4 ? `${lines[i].slice(0, max / 4)} […]` : lines[i];
    if (used + l.length + 1 > max) break;
    tail.unshift(l);
    used += l.length + 1;
  }
  const skipped = lines.length - 1 - tail.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier ${skipped === 1 ? 'entry' : 'entries'} left out to keep this short …]`] : []), ...tail].join('\n');
}
