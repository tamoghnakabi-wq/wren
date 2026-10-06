import Image from 'next/image';
import Link from 'next/link';
import { cx } from '@/lib/cx';
import { ArrowRight, Check, Cloud, KeyRound, Laptop, ListChecks, Lock, MonitorSmartphone, Repeat, ShieldCheck, Smartphone, Terminal, Globe, FileText } from 'lucide-react';
import { GithubMark as Github } from '@/components/brand';
import { AgentAvatar } from '@/components/agent-avatar';
import { AgentCharacter } from '@/components/agent-character';
import { CHARACTERS, type CharacterKey, type Mood } from '@/lib/characters';
import { SiteFooter, SiteNav } from '@/components/site';
import { DownloadButtons } from '@/components/download-buttons';

export default function Landing() {
  return (
    <div className="overflow-x-hidden">
      <SiteNav />
      <main>
        <Hero />
        <Pillars />
        <HowItWorks />
        <Crew />
        <RemoteControl />
        <Plans />
        <Safety />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative">
      <div className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-[620px] bg-[radial-gradient(60%_50%_at_50%_0%,var(--brand-soft),transparent_70%)]" />
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-12 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-24">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] text-muted shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Web · macOS · Windows
          </span>
          <h1 className="mt-5 font-display text-[44px] leading-[1.02] tracking-tight sm:text-[64px]">
            Agents that do the work.
            <br />
            <span className="text-brand italic">Wherever you are.</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">
            Wren gives you a team of persistent AI agents with their own computers. They research, code, browse and handle files — in the cloud or on your own Mac or PC — while you watch live, approve what matters from your phone, and get the results.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/signup" className="inline-flex h-12 items-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-medium text-primary-fg shadow-sm hover:opacity-90">
              Start free <ArrowRight className="h-4 w-4" />
            </Link>
            <DownloadButtons compact />
          </div>
          <p className="mt-4 text-[13px] text-faint">Use your ChatGPT, Claude or Grok plan on your computer — or bring an API key.</p>
        </div>
        <HeroMock />
      </div>
    </section>
  );
}

function HeroMock() {
  const steps = [
    { icon: Globe, text: 'Open rentals.example.com/melbourne', done: true },
    { icon: ListChecks, text: 'Read 24 listings under $750/week', done: true },
    { icon: Terminal, text: 'Run `python rank.py --commute cbd`', done: true },
    { icon: FileText, text: 'Write shortlist.md', done: false },
  ];
  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      <div className="rounded-[28px] border border-border bg-surface p-4 shadow-pop">
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <AgentAvatar icon="kit" color="blue" size={42} mood="working" seed="hero" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Find a 2-bed rental near the CBD</p>
            <p className="text-[12px] text-faint">Scout · Cloud computer</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[12px] font-medium text-success">
            <span className="h-1.5 w-1.5 animate-wren-pulse rounded-full bg-success" /> Working
          </span>
        </div>
        <div className="mt-3 space-y-1.5">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]">
              <s.icon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
              <span className={cx('min-w-0 truncate', s.done ? 'text-muted' : 'text-shimmer font-medium')}>{s.text}</span>
              <span className="ml-auto shrink-0">{s.done ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <span className="block h-3.5 w-3.5 rounded-full border-2 border-success border-t-transparent motion-safe:animate-spin" />}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-1.5 border-b border-border bg-bg-subtle px-2.5 py-1.5">
            <span className="h-2 w-2 rounded-full bg-border-strong" />
            <span className="h-2 w-2 rounded-full bg-border-strong" />
            <span className="h-2 w-2 rounded-full bg-border-strong" />
            <span className="ml-2 truncate text-[11px] text-faint">rentals.example.com/melbourne?beds=2</span>
          </div>
          <div className="grid grid-cols-3 gap-2 p-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="space-y-1">
                {/* Fictional, AI-generated listing photos (public/demo); small enough not to need optimising. */}
                <Image src={`/demo/rental-${i + 1}.webp`} alt="" width={480} height={160} unoptimized className="h-12 w-full rounded-md bg-bg-subtle object-cover dark:brightness-90" />
                <div className="h-1.5 w-4/5 rounded bg-border" />
                <div className="h-1.5 w-1/2 rounded bg-border" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -right-2 -bottom-10 w-[230px] rotate-[3deg] rounded-[26px] border border-border bg-surface p-3 shadow-pop sm:-right-10">
        <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning">
          <AgentCharacter character="bolt" color="violet" mood="waiting" size={26} seed="hero-forge" /> Approval needed
        </p>
        <p className="mt-1 text-[13px] font-medium">Forge wants to run `git push origin fix/login`</p>
        <div className="mt-2.5 flex gap-1.5">
          <span className="flex-1 rounded-lg bg-primary py-1.5 text-center text-[12px] font-medium text-primary-fg">Approve</span>
          <span className="flex-1 rounded-lg border border-border py-1.5 text-center text-[12px] font-medium">Deny</span>
        </div>
      </div>
    </div>
  );
}

function Pillars() {
  const items = [
    { icon: Cloud, title: 'Its own computer', body: 'Every agent gets a persistent cloud computer with a terminal, files and a real browser. It keeps working when your laptop is closed.' },
    { icon: Laptop, title: 'Your computer, too', body: 'Install Wren on macOS or Windows and agents can work with your local files and apps — only in folders you allow.' },
    { icon: MonitorSmartphone, title: 'Control from anywhere', body: 'Start tasks from your phone, watch every step live, answer questions and approve sensitive actions with a tap.' },
    { icon: KeyRound, title: 'Your AI plans', body: 'Use your ChatGPT plan, Claude Code or Grok Build on your computer, local models, or API keys in the cloud.' },
  ];
  return (
    <section className="border-y border-border bg-surface/60">
      <div className="mx-auto grid max-w-6xl gap-px px-4 py-6 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {items.map((i) => (
          <div key={i.title} className="p-5">
            <i.icon className="h-6 w-6 text-brand" />
            <h3 className="mt-3 font-semibold">{i.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{i.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { n: '1', title: 'Create an agent', body: 'Give it a name, instructions and a brain. Start from templates like a researcher, an engineer or a personal assistant.' },
    { n: '2', title: 'Hand it real work', body: '“Fix the failing test and open a PR.” “Compare these three suppliers.” “Every weekday at 8am, brief me on…” Attach files if you like.' },
    { n: '3', title: 'Stay in the loop', body: 'Follow the plan and every action live. The agent asks when it needs you, and stops for your approval before anything risky.' },
    { n: '4', title: 'Get results', body: 'Reports, code, files and summaries arrive in the task and in your files — with a notification on your phone.' },
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="max-w-2xl font-display text-[36px] leading-tight tracking-tight sm:text-[44px]">Delegate like you would to a capable teammate.</h2>
      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <div key={s.n} className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand">{s.n}</span>
            <h3 className="mt-4 font-semibold">{s.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-3 text-sm text-muted sm:grid-cols-3">
        <p className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-brand" /> Schedules for recurring work
        </p>
        <p className="flex items-center gap-2">
          <Github className="h-4 w-4 text-brand" /> GitHub and any MCP server as tools
        </p>
        <p className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-brand" /> Memory that learns your preferences
        </p>
      </div>
    </section>
  );
}

function Crew() {
  const crew: { c: CharacterKey; color: string; mood: Mood; label: string; line: string }[] = [
    { c: 'kit', color: 'blue', mood: 'thinking', label: 'Thinking', line: 'Reading the brief' },
    { c: 'bolt', color: 'violet', mood: 'working', label: 'Working', line: 'Running the tests' },
    { c: 'sprout', color: 'teal', mood: 'waiting', label: 'Needs you', line: 'Asks before anything risky' },
    { c: 'orbit', color: 'amber', mood: 'success', label: 'Done', line: 'Your shortlist is ready' },
    { c: 'drop', color: 'rose', mood: 'error', label: 'Stuck', line: 'Says what went wrong' },
    { c: 'pip', color: 'orange', mood: 'idle', label: 'Ready', line: 'Waiting for the next job' },
  ];
  return (
    <section className="border-y border-border bg-surface/60">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="max-w-2xl font-display text-[36px] leading-tight tracking-tight sm:text-[44px]">A crew with personality.</h2>
        <p className="mt-3 max-w-xl text-muted">Every agent gets its own character, so you can tell at a glance who’s thinking, who’s busy, and who’s waiting on you.</p>
        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {crew.map((m) => (
            <div key={m.c} className="flex flex-col items-center rounded-2xl border border-border bg-surface px-3 pt-5 pb-4 text-center shadow-card">
              <AgentCharacter character={m.c} color={m.color} mood={m.mood} size={76} seed={m.c} settle={false} title={`${CHARACTERS[m.c].name}, ${m.label.toLowerCase()}`} />
              <p className="mt-2 text-sm font-semibold">{CHARACTERS[m.c].name}</p>
              <p className="text-[12px] font-medium text-brand-ink">{m.label}</p>
              <p className="mt-1 text-[12px] leading-snug text-muted">{m.line}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function RemoteControl() {
  return (
    <section className="bg-primary text-primary-fg">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
        <div>
          <Smartphone className="h-8 w-8 opacity-80" />
          <h2 className="mt-4 font-display text-[36px] leading-tight tracking-tight sm:text-[44px]">Your agents, in your pocket.</h2>
          <p className="mt-4 text-[16px] leading-relaxed opacity-75">
            From your phone, start a task on the cloud or on your desktop at home. Watch the agent’s screen, steer it mid-task, approve a deploy from the train, and get a push notification the moment it’s done. Install Wren to your home screen — no app store needed.
          </p>
          <ul className="mt-6 space-y-2.5 text-[15px]">
            {['Live timeline of every command, page and file', 'One-tap approvals with the exact action shown', 'Answer the agent’s questions in the thread', 'Push notifications for results, questions and approvals'].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <Check className="h-4 w-4 opacity-70" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="mx-auto w-[280px] rounded-[44px] border-[10px] border-white/10 bg-bg p-3 text-text shadow-2xl">
          <div className="space-y-2.5 rounded-[32px] bg-bg p-2">
            <div className="flex items-center gap-2 rounded-2xl bg-surface p-3 shadow-card">
              <AgentCharacter character="bolt" color="violet" mood="success" size={30} seed="phone-forge" still />
              <div className="min-w-0">
                <p className="text-[12px] font-semibold">Forge finished</p>
                <p className="truncate text-[11.5px] text-muted">Opened PR #42 “Fix login redirect loop”</p>
              </div>
            </div>
            <div className="rounded-2xl border border-warning/40 bg-surface p-3 shadow-card">
              <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning">
                <AgentCharacter character="orbit" color="amber" mood="waiting" size={24} seed="phone-atlas" /> Atlas needs approval · High risk
              </p>
              <p className="mt-1 text-[12.5px] font-medium">Delete 1,204 duplicate photos in ~/Pictures/Imports</p>
              <div className="mt-2 flex gap-1.5">
                <span className="flex-1 rounded-lg bg-primary py-1.5 text-center text-[11.5px] font-medium text-primary-fg">Approve</span>
                <span className="flex-1 rounded-lg border border-border py-1.5 text-center text-[11.5px]">Deny</span>
              </div>
            </div>
            <div className="rounded-2xl bg-surface p-3 shadow-card">
              <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-info">
                <AgentCharacter character="sprout" color="teal" mood="thinking" size={24} seed="phone-juniper" /> Juniper asks
              </p>
              <p className="mt-1 text-[12.5px]">Window or aisle for the Hobart flight?</p>
              <div className="mt-2 rounded-full border border-border px-3 py-1.5 text-[11.5px] text-faint">Reply…</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Plans() {
  const rows = [
    { name: 'ChatGPT Plus / Pro', how: 'Official “Sign in with ChatGPT” in the desktop app', where: 'Your computer', ok: true },
    { name: 'Claude Pro / Max', how: 'Anthropic’s own Claude Code app, signed in by you', where: 'Your computer', ok: true },
    { name: 'SuperGrok / X Premium', how: 'xAI’s official Grok Build CLI, signed in by you', where: 'Your computer', ok: true },
    { name: 'Local models', how: 'LM Studio, Ollama or any OpenAI-compatible server', where: 'Your computer', ok: true },
    { name: 'OpenAI, Anthropic, xAI, Vercel API keys', how: 'Encrypted, used only by Wren’s servers', where: 'Cloud & computer', ok: true },
  ];
  return (
    <section id="plans" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 className="font-display text-[36px] leading-tight tracking-tight sm:text-[44px]">Use the AI plans you already pay for.</h2>
          <p className="mt-4 text-[16px] leading-relaxed text-muted">
            Wherever a provider officially allows it, Wren runs on your existing subscription — no second bill. We never scrape sessions or impersonate official apps: providers currently allow plan usage only from your own computer, so cloud agents use an API key.
          </p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {rows.map((r) => (
            <div key={r.name} className="flex items-start gap-3 border-b border-border px-5 py-4 last:border-0">
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.name}</p>
                <p className="text-[13px] text-muted">{r.how}</p>
              </div>
              <span className="shrink-0 rounded-full bg-bg-subtle px-2.5 py-0.5 text-[12px] text-muted">{r.where}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Safety() {
  const items = [
    { icon: ShieldCheck, title: 'Approvals for what matters', body: 'Deleting, publishing, pushing, sending and spending stop for your OK. You choose how cautious each agent is.' },
    { icon: Lock, title: 'Hard limits', body: 'Agents never type passwords or card numbers, complete payments, or run catastrophic commands — whatever the setting.' },
    { icon: Laptop, title: 'Local permissions stay local', body: 'Which folders an agent may touch on your computer is set on that computer and can’t be changed remotely.' },
    { icon: KeyRound, title: 'Keys stay out of reach', body: 'API keys are encrypted and never enter an agent’s computer, so a malicious web page can’t trick an agent into leaking them.' },
  ];
  return (
    <section className="border-t border-border bg-surface/60">
      <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <h2 className="max-w-2xl font-display text-[36px] leading-tight tracking-tight sm:text-[44px]">Powerful, with the brakes in your hands.</h2>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {items.map((i) => (
            <div key={i.title} className="flex gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <i.icon className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-semibold">{i.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{i.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 text-center sm:px-6">
      <h2 className="font-display text-[40px] leading-tight tracking-tight sm:text-[52px]">Give your first agent a job.</h2>
      <p className="mx-auto mt-4 max-w-xl text-[16px] text-muted">Free to start. Works in your browser and on your phone; add the desktop app when you want agents on your own computer.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/signup" className="inline-flex h-12 items-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-medium text-primary-fg shadow-sm hover:opacity-90">
          Create your account <ArrowRight className="h-4 w-4" />
        </Link>
        <DownloadButtons compact />
      </div>
    </section>
  );
}
