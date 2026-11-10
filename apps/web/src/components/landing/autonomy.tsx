'use client';

import { useState } from 'react';
import { cx } from '@/lib/cx';

// Mirrors packages/core/src/policy.ts: careful asks from medium risk, balanced from high,
// autonomous only for critical; blocked actions never run.
type Level = 'careful' | 'balanced' | 'autonomous';
type Risk = 'low' | 'medium' | 'high' | 'critical' | 'blocked';

const LEVELS: { value: Level; label: string; note: string }[] = [
  { value: 'careful', label: 'Careful', note: 'Asks before anything that changes your files or the outside world.' },
  { value: 'balanced', label: 'Balanced', note: 'Gets on with ordinary work and asks before anything that publishes, sends or deletes.' },
  { value: 'autonomous', label: 'Autonomous', note: 'Asks only before the few actions that can’t be undone or open up your accounts.' },
];

const ACTIONS: { text: string; risk: Risk }[] = [
  { text: 'Read the files in a folder you allowed', risk: 'low' },
  { text: 'Install a package and run the tests', risk: 'medium' },
  { text: 'Push a branch to GitHub or send an email', risk: 'high' },
  { text: 'Make a private repository public', risk: 'critical' },
  { text: 'Type your password or a card number', risk: 'blocked' },
];

const ASKS_FROM: Record<Level, number> = { careful: 1, balanced: 2, autonomous: 3 };
const ORDER: Risk[] = ['low', 'medium', 'high', 'critical'];

function outcome(level: Level, risk: Risk): 'runs' | 'asks' | 'never' {
  if (risk === 'blocked') return 'never';
  return ORDER.indexOf(risk) >= ASKS_FROM[level] ? 'asks' : 'runs';
}

export function AutonomyPicker() {
  const [level, setLevel] = useState<Level>('balanced');
  const note = LEVELS.find((l) => l.value === level)!.note;
  return (
    <div className="rounded-[20px] border border-border bg-surface p-2 shadow-card">
      <div role="radiogroup" aria-label="How much an agent asks" className="grid grid-cols-3 gap-1 rounded-[14px] bg-bg-subtle p-1">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={level === l.value}
            onClick={() => setLevel(l.value)}
            className={cx('h-10 rounded-[10px] text-[14px] font-semibold transition-[background-color,color,box-shadow]', level === l.value ? 'bg-surface text-text shadow-card' : 'text-muted hover:text-text')}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="px-3 pt-4 pb-2 text-[14px] text-muted" aria-live="polite">
        {note}
      </p>
      <ul className="divide-y divide-border">
        {ACTIONS.map((a) => {
          const o = outcome(level, a.risk);
          return (
            <li key={a.text} className="flex items-center gap-3 px-3 py-3">
              <span className="min-w-0 flex-1 text-[14.5px]">{a.text}</span>
              <span
                className={cx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold transition-colors duration-200',
                  o === 'runs' && 'bg-bg-subtle text-muted',
                  o === 'asks' && 'bg-warning-soft text-warning',
                  o === 'never' && 'bg-danger-soft text-danger',
                )}
              >
                {o === 'asks' && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lamp" />}
                {o === 'runs' ? 'Runs' : o === 'asks' ? 'Asks you' : 'Never'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
