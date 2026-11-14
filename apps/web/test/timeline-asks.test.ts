import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EventRow } from '../src/lib/client/types';

// A task's timeline while its agent asks another (task.ask_agent). A run that ended (stopped, failed, or
// its desktop app quit) can leave the ask's step at "awaiting_agent", which nothing answers any more:
// that step said "Claude is working on the answer" for good, and a later run's footer said "Waiting for
// Claude's answer…" instead of what that run was doing.

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/app/s/s1' }));
vi.mock('@/components/app/code-text', () => import('../src/components/app/code-text'));
vi.mock('@/lib/cx', () => import('../src/lib/cx'));
vi.mock('@/lib/characters', () => import('../src/lib/characters'));
vi.mock('@/lib/markdown-rules', () => import('../src/lib/markdown-rules'));
vi.mock('@/lib/client/api', () => ({ api: async () => ({}) }));
vi.mock('@/lib/client/desktop', () => import('../src/lib/client/desktop'));
vi.mock('@/components/ui', () => import('../src/components/ui'));
vi.mock('../src/components/app/approval-card', () => ({ ApprovalCard: () => null })); // no approvals here
const { Timeline } = await import('../src/components/app/timeline');

const at = new Date(Date.now() - 5_000).toISOString();
let seq = 0;
function row(run: string, type: EventRow['type'], status: string, data: Record<string, unknown>): EventRow {
  seq++;
  return { id: `ev${seq}`, seq, session_id: 's1', run_id: run, type, status, data, created_at: at, updated_at: at };
}
const asked = (run: string) => row(run, 'tool', 'awaiting_agent', { name: 'task.ask_agent', title: 'Ask Claude: Queue or cron?', args: { agent: 'Claude', question: 'Queue or cron?' }, ask: { sessionId: 'child-1', agent: 'Claude' }, startedAt: Date.now() - 5_000 });
const said = (run: string, text: string) => row(run, 'message', 'done', { role: 'user', text });

describe('a timeline with an ask in it', () => {
  it('shows a running run’s ask as waiting for that agent', () => {
    const html = renderToString(createElement(Timeline, { events: [said('r1', 'Ask Claude'), asked('r1')], approvals: [], working: true }));
    expect(html).toContain('Claude is working on the answer.');
    expect(html).toContain('Waiting for Claude’s answer…');
  });

  it('shows an ask an ended run left open as not finished, and the next run as doing its own work', () => {
    const events = [said('r1', 'Ask Claude'), asked('r1'), said('r2', 'Never mind, just pick one')];
    const html = renderToString(createElement(Timeline, { events, approvals: [], working: true, endedRuns: ['r1'] }));
    expect(html).toContain('Didn’t finish');
    expect(html).not.toContain('is working on the answer');
    expect(html).not.toContain('Waiting for Claude’s answer');
    expect(html).toContain('href="/app/s/child-1"'); // the asked task stays reachable
    expect(html).toContain('Thinking…');
  });
});
