import type { ReactNode } from 'react';
import { Ban, Cloud, KeyRound, Laptop, Smartphone } from 'lucide-react';
import { cx } from '@/lib/cx';
import { AgentCharacter } from '@/components/agent-character';
import { CHARACTERS, type CharacterKey, type Mood } from '@/lib/characters';
import { SiteFooter, SiteNav } from '@/components/site';
import { DownloadButtons } from '@/components/download-buttons';
import { HeroRun } from '@/components/landing/hero-run';
import { AutonomyPicker } from '@/components/landing/autonomy';

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      <main>
        <Hero />
        <Computers />
        <Day />
        <Crew />
        <Plans />
        <Brakes />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

const h2 = 'font-display text-[clamp(36px,4.8vw,60px)] leading-[0.96] font-bold';
const lede = 'mt-5 max-w-[56ch] text-[17px] leading-relaxed text-muted';

function StartFree({ children = 'Start free' }: { children?: ReactNode }) {
  return (
    <a href="/signup" className="inline-flex h-12 items-center rounded-[10px] bg-night-text px-6 text-[15px] font-semibold text-night transition-[background-color,transform] hover:bg-white active:scale-[0.97]">
      {children}
    </a>
  );
}

// ------------------------------------------------------------------ hero

function Hero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-night-line bg-night text-night-text">
      <SiteNav tone="night" />
      <div className="mx-auto max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:pt-40 lg:pb-28">
        <h1 className="font-display text-[clamp(46px,7.4vw,100px)] leading-[0.9] font-[760]">
          <span className="block">It does the work.</span>
          <span className="block">You keep the last word.</span>
        </h1>
        <div className="mt-9 grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <p className="max-w-[52ch] text-[17px] leading-relaxed text-night-muted sm:text-[18px]">
            Wren agents research, code, browse and handle files on their own cloud computer or on your Mac or PC. You watch each step as it happens and approve anything risky from your phone.
          </p>
          <div>
            <div className="flex flex-wrap gap-3">
              <StartFree />
              <DownloadButtons tone="night" />
            </div>
            <p className="mt-3 text-[13px] text-night-muted">Runs on your ChatGPT, Claude or Grok plan, or an API key.</p>
          </div>
        </div>
        <div className="mt-14 lg:mt-16">
          <HeroRun />
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ where it works

function Computers() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
      <h2 className={cx(h2, 'max-w-3xl')}>Two computers and a phone.</h2>
      <p className={lede}>Every agent has a computer in the cloud that keeps going when your laptop is shut. Install Wren on your Mac or PC and agents can work there too, in the folders you choose. Your phone is where you keep an eye on all of it.</p>
      <div className="mt-14 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Strip icon={Cloud} title="Its own computer in the cloud" body="A terminal, files and a real browser that belong to the agent. Work carries on overnight, and nothing it installs touches your machine.">
            <div className="rounded-[12px] bg-night p-4 font-mono text-[12px] leading-[1.75] text-night-muted">
              <p className="text-night-text">~/workspace $ npm test</p>
              <p>
                <span className="text-[#5be39a]">128 passed</span> in 9.4s
              </p>
              <p className="text-night-text">~/workspace $ gh pr create --fill</p>
              <p className="truncate text-night-text">github.com/you/site/pull/42</p>
            </div>
          </Strip>
          <Strip icon={Laptop} title="Your Mac or PC, on your terms" body="Agents use your own apps and your ChatGPT, Claude or Grok plan. They only see the folders you allow, and turning anything on asks on that computer.">
            <ul className="divide-y divide-border rounded-[12px] border border-border bg-bg text-[13px]">
              {[
                ['~/Projects/site', 'Allowed', 'text-brand-ink'],
                ['~/Documents/Quotes', 'Allowed', 'text-brand-ink'],
                ['~/.ssh', 'Never', 'text-danger'],
                ['Everything else', 'Off', 'text-faint'],
              ].map(([path, state, cls]) => (
                <li key={path} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <span className={cx('truncate', path.startsWith('~') && 'font-mono text-[12px]')}>{path}</span>
                  <span className={cx('shrink-0 font-semibold', cls)}>{state}</span>
                </li>
              ))}
            </ul>
          </Strip>
        </div>
        <Phone />
      </div>
    </section>
  );
}

function Strip({ icon: Icon, title, body, children }: { icon: typeof Cloud; title: string; body: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-6 rounded-[20px] border border-border bg-surface p-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] sm:p-7">
      <div>
        <Icon className="h-6 w-6 text-brand-ink" aria-hidden />
        <h3 className="mt-4 font-display text-[26px] leading-tight font-bold">{title}</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Phone() {
  return (
    <div className="flex flex-col rounded-[20px] bg-night p-6 text-night-text ring-1 ring-night-line ring-inset sm:p-7">
      <Smartphone className="h-6 w-6 text-night-text" aria-hidden />
      <h3 className="mt-4 font-display text-[26px] leading-tight font-bold">In your pocket</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-night-muted">Start a task from the tram, approve a push in the coffee queue, and get a notification when it’s done. Add Wren to your home screen; there’s no app store.</p>
      <div className="mt-6 flex flex-1 items-end justify-center">
        <div className="w-full max-w-[290px] rounded-[38px] border-[7px] border-night-3 bg-night-2 p-2.5 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.9)]">
          <div className="space-y-2 rounded-[30px] p-1">
            <Notice who="bolt" color="violet" mood="success" title="Forge finished" text="Opened pull request #42, “Fix the login redirect loop”" />
            <div className="rounded-[18px] border border-lamp/50 bg-lamp/[0.08] p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-lamp">
                <AgentCharacter character="orbit" color="amber" mood="waiting" size={22} seed="phone-atlas" /> Atlas needs you
              </p>
              <p className="mt-1 text-[13px] leading-snug">Delete 1,204 duplicate photos in ~/Pictures/Imports?</p>
              <div className="mt-2.5 flex gap-1.5 text-[12px] font-semibold">
                <span className="flex-1 rounded-[9px] bg-lamp py-1.5 text-center text-lamp-ink">Approve</span>
                <span className="flex-1 rounded-[9px] bg-night-3 py-1.5 text-center">Deny</span>
              </div>
            </div>
            <Notice who="sprout" color="teal" mood="thinking" title="Juniper asks" text="Window or aisle for the Hobart flight?" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Notice({ who, color, mood, title, text }: { who: CharacterKey; color: string; mood: Mood; title: string; text: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[18px] bg-night-3 p-3">
      <AgentCharacter character={who} color={color} mood={mood} size={28} seed={`phone-${who}`} still />
      <div className="min-w-0">
        <p className="text-[12px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-snug text-night-muted">{text}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ a day

const DAY: { time: string; ampm: string; who?: { c: CharacterKey; color: string; mood: Mood }; title: string; body: ReactNode }[] = [
  { time: '7:00', ampm: 'am', who: { c: 'sprout', color: 'teal', mood: 'success' }, title: 'Your weekday brief arrives', body: 'A schedule you set up once. Juniper reads your calendar and the news you follow, and sends three lines before breakfast.' },
  { time: '8:40', ampm: 'am', title: 'You hand Forge a bug from the tram', body: '“The login test is failing on main. Fix it and open a pull request.” Forge starts on its cloud computer straight away.' },
  {
    time: '9:05',
    ampm: 'am',
    who: { c: 'bolt', color: 'violet', mood: 'waiting' },
    title: 'Forge stops before pushing',
    body: (
      <>
        It shows exactly what it wants to run. You check the branch name and approve with one tap.
        <span className="mt-3 flex w-fit max-w-full items-center gap-2.5 rounded-[10px] border border-border bg-bg py-1.5 pr-1.5 pl-3">
          <code className="truncate font-mono text-[12.5px] text-text">git push origin fix/login-redirect</code>
          <span className="shrink-0 rounded-[7px] bg-lamp px-2 py-0.5 text-[12px] font-semibold text-lamp-ink">Approved</span>
        </span>
      </>
    ),
  },
  { time: '9:12', ampm: 'am', who: { c: 'bolt', color: 'violet', mood: 'success' }, title: 'Pull request #42 is open', body: 'Your phone buzzes with the link, a summary of the fix and the tests Forge ran.' },
  { time: '2:30', ampm: 'pm', who: { c: 'kit', color: 'orange', mood: 'working' }, title: 'Scout compares quotes on your Mac', body: 'While you’re in a meeting, it reads the three supplier quotes in ~/Documents/Quotes and writes up which to pick. It can’t open any other folder.' },
  { time: '6:10', ampm: 'pm', who: { c: 'orbit', color: 'amber', mood: 'waiting' }, title: 'Atlas asks before deleting anything', body: 'It found 1,204 duplicate photos. You say not yet, and nothing is touched.' },
];

function Day() {
  return (
    <section id="day" className="scroll-mt-16 border-y border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-14 px-4 py-24 sm:px-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:py-32">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <h2 className={h2}>A day with Wren.</h2>
          <p className={lede}>Hand over work as it comes up, from wherever you are. Agents get on with it, check in when they need you, and report back.</p>
        </div>
        <ol>
          {DAY.map((e, i) => (
            <li key={e.time + e.ampm} className="grid grid-cols-[76px_minmax(0,1fr)] sm:grid-cols-[96px_minmax(0,1fr)]">
              <p className="pt-0.5 pr-4 text-right">
                <time className="font-display text-[28px] leading-none font-bold tabular-nums">{e.time}</time>
                <span className="ml-1 text-[13px] font-semibold text-faint">{e.ampm}</span>
              </p>
              <div className={cx('relative border-l border-border pl-6', i < DAY.length - 1 ? 'pb-10' : 'pb-1')}>
                <span aria-hidden className={cx('absolute top-2 -left-[5px] h-[9px] w-[9px] rounded-full ring-4 ring-surface', e.who?.mood === 'waiting' ? 'bg-lamp' : 'bg-brand')} />
                <h3 className="flex items-center gap-2 text-[17px] font-semibold">
                  {e.who && <AgentCharacter character={e.who.c} color={e.who.color} mood={e.who.mood} size={28} seed={`day-${i}`} still />}
                  {e.title}
                </h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{e.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the crew, perched on a wire

const CREW: { c: CharacterKey; color: string; mood: Mood; label: string; tone: string }[] = [
  { c: 'kit', color: 'green', mood: 'thinking', label: 'Thinking', tone: 'text-muted' },
  { c: 'bolt', color: 'violet', mood: 'working', label: 'Working', tone: 'text-success' },
  { c: 'sprout', color: 'teal', mood: 'waiting', label: 'Needs you', tone: 'text-warning' },
  { c: 'orbit', color: 'amber', mood: 'success', label: 'Done', tone: 'text-brand-ink' },
  { c: 'drop', color: 'rose', mood: 'error', label: 'Stuck', tone: 'text-danger' },
  { c: 'pip', color: 'orange', mood: 'idle', label: 'Ready', tone: 'text-muted' },
];

function Crew() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
      <h2 className={cx(h2, 'max-w-3xl')}>Every agent has a face.</h2>
      <p className={lede}>Each agent gets its own character, so you can tell at a glance who is thinking, who is busy and who is waiting on you.</p>
      <div className="mt-14 hidden sm:block">
        <Wire crew={CREW} size={84} sag={34} />
      </div>
      <div className="mt-12 space-y-4 sm:hidden">
        <Wire crew={CREW.slice(0, 3)} size={64} sag={18} />
        <Wire crew={CREW.slice(3)} size={64} sag={18} />
      </div>
    </section>
  );
}

/** Characters perched along a sagging wire. The wire is a quadratic curve, so a perch at x sits 4·sag·x(1−x) lower than the ends. */
function Wire({ crew, size, sag }: { crew: typeof CREW; size: number; sag: number }) {
  const top = size + 14; // where the wire's ends are
  const feet = Math.round(size * 0.94); // just above the bottom of their box, so they grip the wire
  return (
    <div className="relative" style={{ height: top + sag + 74 }}>
      <svg aria-hidden className="absolute inset-x-0 w-full overflow-visible text-border-strong" style={{ top, height: sag * 2 }} viewBox={`0 0 1000 ${sag * 2}`} preserveAspectRatio="none">
        <path d={`M0 0 Q500 ${sag * 2} 1000 0`} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {crew.map((m, i) => {
        const x = (i + 0.5) / crew.length;
        const y = top + 4 * sag * x * (1 - x);
        return (
          <div key={m.c} className="absolute flex -translate-x-1/2 flex-col items-center text-center" style={{ left: `${x * 100}%`, top: y - feet }}>
            <AgentCharacter character={m.c} color={m.color} mood={m.mood} size={size} seed={`wire-${m.c}`} settle={false} title={`${CHARACTERS[m.c].name}, ${m.label.toLowerCase()}`} />
            <p className="mt-3 text-[14px] font-semibold">{CHARACTERS[m.c].name}</p>
            <p className={cx('text-[13px] font-semibold', m.tone)}>{m.label}</p>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ plans

const PLANS: { name: string; how: string; where: string }[] = [
  { name: 'ChatGPT Plus or Pro', how: 'The official Sign in with ChatGPT, in the desktop app', where: 'Your computer' },
  { name: 'Claude Pro or Max', how: 'Anthropic’s own Claude Code, signed in by you', where: 'Your computer' },
  { name: 'SuperGrok or X Premium', how: 'xAI’s official Grok Build, signed in by you', where: 'Your computer' },
  { name: 'Local models', how: 'LM Studio, Ollama or any OpenAI-compatible server', where: 'Your computer' },
  { name: 'API keys', how: 'OpenAI, Anthropic, xAI or Vercel AI Gateway, encrypted and used only by Wren’s servers', where: 'Cloud and computer' },
];

function Plans() {
  return (
    <section id="plans" className="scroll-mt-16 border-y border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:py-32">
        <div>
          <h2 className={h2}>Use the AI plans you already pay for.</h2>
          <p className={lede}>Wherever a provider allows it, Wren runs on the subscription you have, so there’s no second bill. It never scrapes sessions or pretends to be an official app. Providers only allow plan use from your own computer, so cloud agents use an API key.</p>
        </div>
        <dl className="divide-y divide-border border-y border-border self-start">
          {PLANS.map((p) => (
            <div key={p.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-5">
              <dt className="text-[17px] font-semibold">{p.name}</dt>
              <dd className="text-right text-[13px] font-semibold text-brand-ink">{p.where}</dd>
              <dd className="col-span-2 mt-1 text-[15px] text-muted">{p.how}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ safety

function Brakes() {
  const facts: [typeof Ban, string, string][] = [
    [Ban, 'Hard limits', 'Agents never type passwords or card numbers, and never run commands that would wipe a disk or your home folder, whatever the setting.'],
    [Laptop, 'Your computer, your rules', 'Which folders an agent may use is set on that computer. The web can turn permissions off, but turning anything on asks on the computer itself.'],
    [KeyRound, 'Keys out of reach', 'API keys are encrypted and never enter an agent’s computer, so a page an agent visits can’t trick it into leaking them.'],
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32">
      <div className="grid gap-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start">
        <div>
          <h2 className={h2}>You decide how much it asks.</h2>
          <p className={lede}>Each agent has a setting for how careful to be. Try them here. Whatever you choose, some things always stop for you and some never happen.</p>
          <dl className="mt-10 space-y-6">
            {facts.map(([Icon, t, b]) => (
              <div key={t}>
                <dt className="flex items-center gap-2.5 text-[16px] font-semibold">
                  <Icon className="h-4 w-4 text-brand-ink" aria-hidden />
                  {t}
                </dt>
                <dd className="mt-1 max-w-[52ch] pl-[26px] text-[15px] leading-relaxed text-muted">{b}</dd>
              </div>
            ))}
          </dl>
        </div>
        <AutonomyPicker />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ close

function FinalCta() {
  return (
    <section className="relative isolate overflow-hidden border-t border-night-line bg-night text-night-text">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[70%] bg-[radial-gradient(55%_70%_at_50%_100%,rgb(255_255_255/0.08),transparent_72%)]" />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-24 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:py-32">
        <div>
          <h2 className="font-display text-[clamp(44px,6.6vw,88px)] leading-[0.92] font-[760]">Give your first agent a job.</h2>
          <p className="mt-6 max-w-[50ch] text-[17px] leading-relaxed text-night-muted">Free to start in your browser and on your phone. Add the desktop app when you want agents on your own computer.</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <StartFree>Create your account</StartFree>
            <DownloadButtons tone="night" />
          </div>
        </div>
        {/* .wc sets its own display, so the wrapper does the hiding. */}
        <div className="hidden justify-self-end lg:block">
          <AgentCharacter character="pip" color="orange" mood="hello" size={140} seed="final-pip" settle={false} title="Pip, waving" />
        </div>
      </div>
    </section>
  );
}
