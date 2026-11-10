'use client';

import Image from 'next/image';
import { Check, Cloud, FileText, Globe, Mail, RotateCcw, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentCharacter } from '@/components/agent-character';
import { cx } from '@/lib/cx';
import type { Mood } from '@/lib/characters';

// A replay of one task, run in the visitor's browser: the agent works through its steps, stops before
// sending email, and the visitor decides. Nothing here talks to Wren.

type Tool = 'browser' | 'shell' | 'file' | 'mail';
type Step = { tool: Tool; text: string; code?: boolean };
type Phase = 'working' | 'asking' | 'sending' | 'approved' | 'denied';

const STEPS: Step[] = [
  { tool: 'browser', text: 'Opened rentals.example.com/melbourne' },
  { tool: 'browser', text: 'Read 24 two-bedroom listings under $750 a week' },
  { tool: 'shell', text: 'python rank.py --commute "Flinders St"', code: true },
  { tool: 'file', text: 'Wrote shortlist.md with the top six' },
];
const SENT: Step = { tool: 'mail', text: 'Sent 3 inspection requests for Saturday' };

const ICON: Record<Tool, typeof Globe> = { browser: Globe, shell: SquareTerminal, file: FileText, mail: Mail };

const LISTINGS = [
  { suburb: 'Carlton North', rent: 690 },
  { suburb: 'Fitzroy', rent: 745 },
  { suburb: 'Brunswick East', rent: 720 },
  { suburb: 'Collingwood', rent: 735 },
  { suburb: 'Richmond', rent: 710 },
  { suburb: 'Abbotsford', rent: 699 },
];

const STEP_MS = 1100;

export function HeroRun() {
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<Phase>('working');
  const [run, setRun] = useState(0);
  const timers = useRef<number[]>([]);

  // Streams the steps in, then waits for the visitor. With reduced motion it starts at the question.
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
    if (reduced) {
      later(() => {
        setShown(STEPS.length);
        setPhase('asking');
      }, 0);
    } else {
      STEPS.forEach((_, i) => later(() => setShown(i + 1), 700 + i * STEP_MS));
      later(() => setPhase('asking'), 700 + STEPS.length * STEP_MS);
    }
    const list = timers.current;
    return () => {
      list.forEach(clearTimeout);
      timers.current = [];
    };
  }, [run]);

  const approve = () => {
    setPhase('sending');
    timers.current.push(window.setTimeout(() => setPhase('approved'), 900));
  };
  const replay = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setShown(0);
    setPhase('working');
    setRun((n) => n + 1);
  };

  const finished = phase === 'approved' || phase === 'denied';
  const mood: Mood = phase === 'asking' ? 'waiting' : phase === 'approved' ? 'success' : phase === 'denied' ? 'idle' : 'working';
  const status = phase === 'asking' ? 'asking' : finished ? 'done' : 'working';
  const current = phase === 'asking' || phase === 'sending' ? 'mail-draft' : phase === 'approved' ? 'mail-sent' : phase === 'denied' ? 'file' : shown === 0 ? 'browser' : STEPS[shown - 1].tool === 'browser' ? 'browser' : STEPS[shown - 1].tool;

  return (
    <div className="relative">
      {/* The horizon brightens once the task is finished: the one moment the page stages. */}
      <div aria-hidden className={cx('pointer-events-none absolute -inset-x-24 -bottom-24 h-[420px] bg-[radial-gradient(50%_60%_at_50%_100%,rgb(255_255_255/0.11),transparent_72%)] transition-opacity duration-[1400ms] ease-out motion-reduce:transition-none', finished ? 'opacity-100' : 'opacity-40')} />
      <div className="relative overflow-hidden rounded-[22px] border border-night-line bg-night-2 text-night-text shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]">
        {/* Task header */}
        <div className="flex items-center gap-3 border-b border-night-line px-4 py-3 sm:px-5">
          <AgentCharacter character="kit" color="orange" mood={mood} size={40} seed="hero-kit" />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-snug font-semibold sm:truncate">Find a 2-bed rental near the CBD</p>
            <p className="flex items-center gap-1.5 text-[12.5px] text-night-muted">
              Kit <span aria-hidden className="h-1 w-1 rounded-full bg-night-line" /> <Cloud className="h-3.5 w-3.5" aria-hidden /> Cloud computer
            </p>
          </div>
          <StatusChip status={status} />
        </div>

        <div className="grid md:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
          {/* Timeline */}
          <div className="min-h-[338px] border-night-line p-4 sm:p-5 md:border-r">
            <ol className="space-y-1" aria-label="What Kit did">
              {STEPS.slice(0, shown).map((s, i) => (
                <StepRow key={`${run}-${i}`} step={s} active={phase === 'working' && i === shown - 1 && shown < STEPS.length} />
              ))}
              {phase === 'working' && shown === STEPS.length && <Thinking />}
              {phase === 'approved' && <StepRow step={SENT} />}
            </ol>

            {(phase === 'asking' || phase === 'sending') && (
              <div className="hero-pop mt-3 rounded-[14px] border border-lamp/60 bg-lamp/[0.08] p-3.5 shadow-[0_0_56px_-14px_var(--lamp)]" role="group" aria-labelledby="hero-ask">
                <p className="flex items-center gap-2 text-[12.5px] font-semibold text-lamp">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-lamp motion-safe:animate-wren-pulse" /> Needs you
                </p>
                <p id="hero-ask" className="mt-1.5 text-[15px] leading-snug font-semibold">
                  Kit wants to email 3 leasing agents to book inspections.
                </p>
                <p className="mt-1 text-[13px] text-night-muted">Kit is set to Balanced, so sending messages asks you first.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={approve} disabled={phase === 'sending'} className="h-10 flex-1 rounded-[10px] bg-lamp text-[14px] font-semibold text-lamp-ink transition-[transform,filter] hover:brightness-105 active:scale-[0.97] disabled:opacity-70">
                    {phase === 'sending' ? 'Sending…' : 'Approve'}
                  </button>
                  <button type="button" onClick={() => setPhase('denied')} disabled={phase === 'sending'} className="h-10 flex-1 rounded-[10px] border border-night-line bg-night-3 text-[14px] font-semibold transition-[transform,background-color] hover:bg-night-line active:scale-[0.97] disabled:opacity-50">
                    Deny
                  </button>
                </div>
              </div>
            )}

            {finished && (
              <div className="hero-pop mt-3 space-y-3">
                <p className="flex items-center gap-1.5 text-[12.5px] text-night-muted">
                  {phase === 'approved' ? <Check className="h-3.5 w-3.5 text-night-text" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                  {phase === 'approved' ? 'You approved sending the emails' : 'You said no to sending the emails'}
                </p>
                <div className="rounded-[14px] bg-night-3 px-3.5 py-3 text-[14px] leading-relaxed">
                  {phase === 'approved' ? 'Done. Six places are on the shortlist, and the top three have inspection requests in for Saturday at 10.' : 'Okay, I won’t email anyone. The six best places are in shortlist.md whenever you want them.'}
                </div>
                <button type="button" onClick={replay} className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-[13px] font-medium text-night-muted transition-colors hover:text-night-text">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Play it again
                </button>
              </div>
            )}
          </div>

          {/* The agent's computer */}
          <div className="hidden border-t border-night-line bg-night p-4 sm:block sm:p-5 md:border-t-0">
            <Screen mode={current} shown={shown} />
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {phase === 'asking' ? 'Kit needs your approval to email 3 leasing agents.' : phase === 'approved' ? 'Kit sent the emails and finished the task.' : phase === 'denied' ? 'Kit finished without sending emails.' : ''}
      </p>
    </div>
  );
}

function StatusChip({ status }: { status: 'working' | 'asking' | 'done' }) {
  const s = {
    working: { label: 'Working', cls: 'bg-[rgb(91_227_154/0.12)] text-[#5be39a]', dot: 'bg-[#5be39a] motion-safe:animate-wren-pulse' },
    asking: { label: 'Needs you', cls: 'bg-lamp/15 text-lamp', dot: 'bg-lamp motion-safe:animate-wren-pulse' },
    done: { label: 'Done', cls: 'bg-night-text/12 text-night-text', dot: 'bg-night-text' },
  }[status];
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold transition-colors', s.cls)}>
      <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', s.dot)} /> {s.label}
    </span>
  );
}

function StepRow({ step, active }: { step: Step; active?: boolean }) {
  const Icon = ICON[step.tool];
  return (
    <li className="hero-step flex items-center gap-2.5 rounded-lg py-1.5 text-[14px]">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-night-3 text-night-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className={cx('min-w-0 flex-1 leading-snug sm:truncate', step.code && 'font-mono text-[12.5px]', active ? 'text-night-text' : 'text-night-muted')}>{step.text}</span>
      {active ? <span aria-hidden className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-night-text border-t-transparent motion-safe:animate-spin" /> : <Check className="h-4 w-4 shrink-0 text-night-text" aria-hidden />}
    </li>
  );
}

function Thinking() {
  return (
    <li className="hero-step flex items-center gap-2.5 py-1.5 text-[14px] text-night-muted">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-night-muted motion-safe:animate-wren-pulse" />
      </span>
      Drafting emails to the agents
    </li>
  );
}

/** What the agent's computer shows for the current step. */
function Screen({ mode, shown }: { mode: string; shown: number }) {
  const url = mode === 'browser' ? 'rentals.example.com/melbourne?beds=2&max=750' : mode === 'shell' ? 'Terminal' : mode === 'file' ? 'shortlist.md' : 'New message';
  return (
    <div className="flex h-full min-h-[290px] flex-col overflow-hidden rounded-[12px] border border-night-line bg-night-2">
      <div className="flex items-center gap-1.5 border-b border-night-line px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-night-line" />
        <span className="h-2 w-2 rounded-full bg-night-line" />
        <span className="h-2 w-2 rounded-full bg-night-line" />
        <span className="ml-2 truncate font-mono text-[11px] text-night-muted">{url}</span>
      </div>
      <div key={mode} className="hero-fade flex-1 p-3">
        {mode === 'browser' && (
          <div className="grid grid-cols-3 gap-2.5">
            {LISTINGS.map((l, i) => (
              <div key={l.suburb} className="min-w-0">
                {/* Fictional, AI-generated listing photos (public/demo). */}
                <Image src={`/demo/rental-${i + 1}.webp`} alt="" width={480} height={160} unoptimized className={cx('h-14 w-full rounded-md object-cover transition-opacity duration-500', shown >= 2 && i >= 3 ? 'opacity-60' : 'opacity-100')} />
                {shown >= 2 ? (
                  <>
                    <p className="mt-1 truncate text-[11.5px] font-semibold">${l.rent} a week</p>
                    <p className="truncate text-[11px] text-night-muted">{l.suburb}</p>
                  </>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    <div className="h-1.5 w-4/5 rounded bg-night-line" />
                    <div className="h-1.5 w-1/2 rounded bg-night-line" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {mode === 'shell' && (
          <pre className="font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap text-night-muted">
            <span className="text-night-text">$ python rank.py --commute &quot;Flinders St&quot;</span>
            {'\n'}Ranking 24 listings by rent and commute{'\n'}
            {'  1  Carlton North    $690   14 min\n'}
            {'  2  Abbotsford       $699   12 min\n'}
            {'  3  Fitzroy          $745   11 min\n'}
            {'  4  Brunswick East   $720   19 min\n'}
            <span className="text-night-text">Wrote ranked.csv</span>
          </pre>
        )}
        {mode === 'file' && (
          <div className="space-y-2 text-[12.5px] leading-relaxed">
            <p className="font-display text-[17px] font-bold">Shortlist: 2-bed near the CBD</p>
            {['Lygon St, Carlton North: $690, 14 min to Flinders St', 'Johnston St, Abbotsford: $699, 12 min', 'Gore St, Fitzroy: $745, 11 min', 'Nicholson St, Brunswick East: $720, 19 min'].map((t, i) => (
              <p key={t} className="flex gap-2 text-night-muted">
                <span className="w-4 shrink-0 text-right tabular-nums text-night-text">{i + 1}.</span> {t}
              </p>
            ))}
          </div>
        )}
        {(mode === 'mail-draft' || mode === 'mail-sent') && (
          <div className="space-y-2 text-[12.5px]">
            <p className="text-night-muted">
              To <span className="text-night-text">3 leasing agents</span>
            </p>
            <p className="text-night-muted">
              Subject <span className="text-night-text">Inspection request for Saturday</span>
            </p>
            <div className="border-t border-night-line pt-2 leading-relaxed text-night-muted">Hi, I’d like to inspect the 2-bedroom place this Saturday at 10am if it’s still available. Thanks, Sam</div>
            <p className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold', mode === 'mail-sent' ? 'bg-night-text/12 text-night-text' : 'bg-lamp/15 text-lamp')}>
              {mode === 'mail-sent' ? <Check className="h-3 w-3" aria-hidden /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lamp" />}
              {mode === 'mail-sent' ? 'Sent' : 'Waiting for your approval'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
