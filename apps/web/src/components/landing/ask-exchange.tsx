'use client';

import { Check, FileText, MessagesSquare, RotateCcw, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentCharacter } from '@/components/agent-character';
import { cx } from '@/lib/cx';
import type { Mood } from '@/lib/characters';

// A replay of one agent asking another (task.ask_agent), in the visitor's browser: Forge, on a Claude plan,
// asks Quill, on a ChatGPT plan, about its fix; Quill works on the question as a task of its own and the
// answer goes back to Forge. The wording follows the app's own. Nothing here talks to Wren.

const QUESTION = 'Does this fix miss an edge case?';
const ANSWER = 'Expired cookies still loop. Check the expiry too.';

/** Moments of the replay, in order; each one's time (ms after it starts). */
const BEATS = [
  ['forge1', 600],
  ['forge2', 1500],
  ['ask', 2500],
  ['quillStart', 3100],
  ['quill1', 3800],
  ['quill2', 4700],
  ['answer', 5900],
  ['back', 6600],
  ['forge4', 7600],
  ['done', 8600],
] as const;
type Beat = (typeof BEATS)[number][0];
const ORDER: Beat[] = BEATS.map(([b]) => b);

export function AskExchange() {
  const [at, setAt] = useState(-1); // index into ORDER of the last moment reached
  const [run, setRun] = useState(0);
  const [seen, setSeen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  // Starts once the panel is in view; with reduced motion it shows the end.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
    if (reduced) later(() => setAt(ORDER.length - 1), 0);
    else BEATS.forEach(([, ms], i) => later(() => setAt(i), ms));
    const list = timers.current;
    return () => {
      list.forEach(clearTimeout);
      timers.current = [];
    };
  }, [seen, run]);

  const reached = (b: Beat) => at >= ORDER.indexOf(b);
  const replay = () => {
    setAt(-1);
    setRun((n) => n + 1);
  };

  const waiting = reached('ask') && !reached('back');
  const forgeDone = reached('done');
  const quillBusy = reached('quillStart') && !reached('answer');
  const forgeMood: Mood = forgeDone ? 'success' : 'working';
  const quillMood: Mood = reached('answer') ? 'success' : quillBusy ? 'working' : 'idle';
  const travel = reached('ask') && !reached('quillStart') ? 'out' : reached('answer') && !reached('back') ? 'back' : undefined;

  return (
    <div ref={box} className="relative overflow-hidden rounded-[22px] bg-night p-3 text-night-text ring-1 ring-night-line ring-inset sm:p-4">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)]">
        {/* The agent that asks */}
        <Card>
          <Header character="bolt" color="violet" mood={forgeMood} seed="ask-forge" title="Fix the login redirect loop" who="Forge" brain="Claude plan" status={forgeDone ? 'done' : at >= 0 ? 'working' : 'ready'} />
          <ol className="space-y-1 p-4" aria-label="What Forge did">
            {reached('forge1') && <Row key={`${run}a`} icon={FileText} text="Found the loop in auth/redirect.ts" />}
            {reached('forge2') && <Row key={`${run}b`} icon={SquareTerminal} text="Wrote a fix and 3 tests" />}
            {reached('ask') && (
              <li key={`${run}c`} className="hero-step rounded-[12px] border border-night-line bg-night-3/60 p-2.5">
                <div className="flex items-center gap-2.5 text-[14px]">
                  <Icon icon={MessagesSquare} />
                  <span className="min-w-0 flex-1 leading-snug">Ask Quill: {QUESTION}</span>
                  {waiting ? <Spinner /> : <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </div>
                {waiting ? (
                  <p className="mt-1.5 pl-[38px] text-[12.5px] text-night-muted">
                    Quill is working on the answer. <span className="font-medium text-night-text underline decoration-night-line underline-offset-2">Open Quill’s task</span>
                  </p>
                ) : (
                  <p className="hero-fade mt-1.5 pl-[38px] text-[13px] leading-snug text-night-muted">
                    Quill answered: <span className="text-night-text">“{ANSWER}”</span>
                  </p>
                )}
              </li>
            )}
            {reached('forge4') && <Row key={`${run}d`} icon={SquareTerminal} text="Added the expiry check and a 4th test" />}
            {waiting && (
              <li className="py-1.5 pl-[38px] text-[13px]">
                <span className="text-shimmer font-medium">Waiting for Quill’s answer…</span>
              </li>
            )}
          </ol>
          {forgeDone && <div className="hero-pop mx-4 mb-4 rounded-[14px] bg-night-3 px-3.5 py-3 text-[14px] leading-relaxed">Done. The fix covers expired cookies too, and pull request #42 is open.</div>}
        </Card>

        {/* Between them: the question goes over, the answer comes back. */}
        <Wire travel={travel} />

        {/* The agent that is asked */}
        <Card dim={!reached('quillStart')}>
          <Header character="puff" color="blue" mood={quillMood} seed="ask-quill" title={reached('quillStart') ? QUESTION : 'No task yet'} who="Quill" brain="ChatGPT plan" status={reached('answer') ? 'done' : quillBusy ? 'working' : 'ready'} />
          <div className="p-4">
            {reached('quillStart') ? (
              <>
                <p key={`${run}n`} className="hero-fade flex items-center gap-2 text-[12.5px] leading-snug text-night-muted">
                  <AgentCharacter character="bolt" color="violet" mood="idle" size={18} seed="ask-note" still />
                  <span>Forge asked this while working on its task. The answer goes back to it.</span>
                </p>
                <ol className="mt-3 space-y-1" aria-label="What Quill did">
                  {reached('quill1') && <Row key={`${run}e`} icon={FileText} text="Read Forge’s change to auth/redirect.ts" />}
                  {reached('quill2') && <Row key={`${run}f`} icon={SquareTerminal} text="npm test -- --cookie=expired" code active={!reached('answer')} />}
                </ol>
                {reached('answer') && <div className="hero-pop mt-3 rounded-[14px] bg-night-3 px-3.5 py-3 text-[14px] leading-relaxed">{ANSWER}</div>}
              </>
            ) : (
              <p className="text-[13px] text-night-muted">Quill is free until someone asks.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-3 flex min-h-8 items-center justify-end px-1">
        {forgeDone && (
          <button type="button" onClick={replay} className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-[13px] font-medium text-night-muted transition-colors hover:text-night-text">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Play it again
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {waiting ? 'Forge asked Quill a question and is waiting for the answer.' : forgeDone ? 'Quill answered, and Forge finished its task with the answer.' : ''}
      </p>
    </div>
  );
}

function Card({ dim, children }: { dim?: boolean; children: ReactNode }) {
  return <div className={cx('min-h-[300px] overflow-hidden rounded-[16px] border border-night-line bg-night-2 transition-opacity duration-500', dim && 'opacity-55')}>{children}</div>;
}

function Header({ character, color, mood, seed, title, who, brain, status }: { character: 'bolt' | 'puff'; color: string; mood: Mood; seed: string; title: string; who: string; brain: string; status: 'ready' | 'working' | 'done' }) {
  const chip = {
    ready: { label: 'Ready', cls: 'bg-night-3 text-night-muted', dot: 'bg-night-muted' },
    working: { label: 'Working', cls: 'bg-[rgb(91_227_154/0.12)] text-[#5be39a]', dot: 'bg-[#5be39a] motion-safe:animate-wren-pulse' },
    done: { label: 'Done', cls: 'bg-night-text/12 text-night-text', dot: 'bg-night-text' },
  }[status];
  return (
    <div className="flex items-center gap-3 border-b border-night-line px-4 py-3">
      <AgentCharacter character={character} color={color} mood={mood} size={36} seed={seed} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] leading-snug font-semibold">{title}</p>
        <p className="flex items-center gap-1.5 text-[12.5px] text-night-muted">
          {who} <span aria-hidden className="h-1 w-1 rounded-full bg-night-line" /> {brain}
        </p>
      </div>
      <span className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors', chip.cls)}>
        <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', chip.dot)} /> {chip.label}
      </span>
    </div>
  );
}

function Icon({ icon: I }: { icon: typeof FileText }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-night-3 text-night-muted">
      <I className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function Spinner() {
  return <span aria-hidden className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-night-text border-t-transparent motion-safe:animate-spin" />;
}

function Row({ icon, text, code, active }: { icon: typeof FileText; text: string; code?: boolean; active?: boolean }) {
  return (
    <li className="hero-step flex items-center gap-2.5 py-1.5 text-[14px]">
      <Icon icon={icon} />
      <span className={cx('min-w-0 flex-1 leading-snug', code && 'font-mono text-[12.5px]', active ? 'text-night-text' : 'text-night-muted')}>{text}</span>
      {active ? <Spinner /> : <Check className="h-4 w-4 shrink-0 text-night-text" aria-hidden />}
    </li>
  );
}

/** The line between the two tasks. A dot carries the question over and the answer back (sideways on wide screens, down and up when the cards stack). */
function Wire({ travel }: { travel?: 'out' | 'back' }) {
  return (
    <div aria-hidden className="relative flex h-12 items-center justify-center lg:h-auto">
      <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-night-line lg:top-1/2 lg:right-0 lg:bottom-auto lg:left-0 lg:h-px lg:w-auto lg:translate-x-0" />
      {travel && <span key={travel} className={cx('ask-dot absolute h-2.5 w-2.5 rounded-full bg-night-text shadow-[0_0_14px_2px_rgb(255_255_255/0.35)]', travel === 'out' ? 'ask-dot-out' : 'ask-dot-back')} />}
    </div>
  );
}
