import { Apple, Download, MonitorDown, ShieldAlert } from 'lucide-react';
import { SiteFooter, SiteNav } from '@/components/site';
import { latestRelease, type ReleaseAsset } from '@/lib/releases';

export const metadata = { title: 'Download' };
export const revalidate = 300;

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export default async function DownloadPage() {
  const r = await latestRelease();
  return (
    <div>
      <section className="relative isolate overflow-hidden border-b border-night-line bg-night text-night-text">
        <SiteNav tone="night" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-2/3 bg-[radial-gradient(50%_70%_at_50%_100%,rgb(255_255_255/0.08),transparent_72%)]" />
        <div className="mx-auto max-w-5xl px-4 pt-32 pb-16 sm:px-6 lg:pt-40 lg:pb-20">
          <h1 className="font-display text-[clamp(44px,7vw,84px)] leading-[0.92] font-[760]">Wren for your computer.</h1>
          <p className="mt-6 max-w-[58ch] text-[17px] leading-relaxed text-night-muted">
            The desktop app lets agents work on your own Mac or PC with your permission and use your ChatGPT plan, Claude Code, Grok Build or local models. It keeps running your tasks while you follow them from your phone, and it updates itself.
          </p>
          {r && (
            <p className="mt-6 text-[14px] text-night-muted">
              Version {r.version}
              {r.prerelease && ' (preview)'}, released {new Date(r.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}.{' '}
              <a href={r.htmlUrl} className="font-semibold text-night-text underline underline-offset-2" target="_blank" rel="noreferrer">
                Release notes
              </a>
            </p>
          )}
        </div>
      </section>

      <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        {!r ? (
          <div className="rounded-[20px] border border-border bg-surface p-6 text-muted shadow-card">The first desktop release is being prepared. The web app works now.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Platform icon={<Apple className="h-7 w-7" />} name="macOS" note="macOS 12 or later" assets={[r.downloads.macArm64 && { label: 'Apple silicon (M1 to M4)', a: r.downloads.macArm64 }, r.downloads.macX64 && { label: 'Intel', a: r.downloads.macX64 }]} />
            <Platform icon={<MonitorDown className="h-7 w-7" />} name="Windows" note="Windows 10 or 11, 64-bit" assets={[r.downloads.windows && { label: 'Windows installer (x64)', a: r.downloads.windows }]} />
          </div>
        )}

        <h2 className="mt-20 font-display text-[clamp(30px,4vw,44px)] leading-none font-bold">After you install</h2>
        <ol className="mt-8 grid gap-8 sm:grid-cols-3">
          {[
            ['Sign in', 'Open Wren and sign in with your Wren account. The computer links itself once you approve it.'],
            ['Choose folders', 'Pick which folders agents may use. Everything else is off-limits, and risky actions ask first.'],
            ['Bring your plan', 'Continue with ChatGPT, sign in to Claude Code or Grok Build, or point Wren at LM Studio.'],
          ].map(([t, b], i) => (
            <li key={t} className="border-t-2 border-text pt-4">
              <p className="font-display text-[28px] leading-none font-bold tabular-nums">{i + 1}</p>
              <p className="mt-3 text-[16px] font-semibold">{t}</p>
              <p className="mt-1 text-[15px] leading-relaxed text-muted">{b}</p>
            </li>
          ))}
        </ol>

        <div className="mt-16 rounded-[20px] border border-warning/30 bg-warning-soft/60 p-6">
          <p className="flex items-center gap-2 font-semibold text-warning">
            <ShieldAlert className="h-5 w-5" aria-hidden /> Opening an unsigned preview for the first time
          </p>
          <p className="mt-2 max-w-[70ch] text-[15px] text-muted">These preview builds aren’t signed with an Apple Developer ID or a Windows code-signing certificate yet, so your computer warns you the first time. Updates are checked separately with Wren’s own signing key.</p>
          <ul className="mt-4 space-y-2 text-[15px] text-muted">
            <li>
              <b className="text-text">macOS:</b> open the .dmg, drag Wren to Applications, then open it. If macOS says it can’t verify the developer, go to System Settings, then Privacy &amp; Security, and click <b className="text-text">Open Anyway</b>.
            </li>
            <li>
              <b className="text-text">Windows:</b> if SmartScreen appears, click <b className="text-text">More info</b>, then <b className="text-text">Run anyway</b>. Wren installs for your user account only, with no admin needed.
            </li>
          </ul>
        </div>

        <p className="mt-12 text-[15px] text-muted">
          Prefer not to install anything?{' '}
          <a href="/signup" className="font-semibold text-text underline underline-offset-2">
            Use Wren on the web
          </a>
          ; cloud agents keep working when your computer is off. The source code is{' '}
          <a href="https://github.com/tamoghnakabi-wq/wren" className="font-semibold text-text underline underline-offset-2" target="_blank" rel="noreferrer">
            on GitHub
          </a>
          .
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function Platform({ icon, name, note, assets }: { icon: React.ReactNode; name: string; note: string; assets: (false | undefined | { label: string; a: ReleaseAsset })[] }) {
  const list = assets.filter(Boolean) as { label: string; a: ReleaseAsset }[];
  return (
    <div className="rounded-[20px] border border-border bg-surface p-6 shadow-card sm:p-7">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="font-display text-[26px] leading-none font-bold">{name}</p>
          <p className="mt-1 text-[13px] text-faint">{note}</p>
        </div>
      </div>
      <div className="mt-6 space-y-2">
        {list.length ? (
          list.map(({ label, a }) => (
            <a key={a.url} href={a.url} className="flex h-12 items-center justify-between rounded-[10px] bg-primary px-4 text-[15px] font-semibold text-primary-fg transition-[opacity,transform] hover:opacity-90 active:scale-[0.98]">
              <span className="flex items-center gap-2">
                <Download className="h-4 w-4" aria-hidden /> {label}
              </span>
              <span className="font-medium opacity-70">{mb(a.size)}</span>
            </a>
          ))
        ) : (
          <p className="text-sm text-muted">Not in this release yet.</p>
        )}
      </div>
    </div>
  );
}
