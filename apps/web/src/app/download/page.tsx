import Link from 'next/link';
import { Apple, Download, ExternalLink, MonitorDown, ShieldAlert } from 'lucide-react';
import { SiteFooter, SiteNav } from '@/components/site';
import { latestRelease, type ReleaseAsset } from '@/lib/releases';

export const metadata = { title: 'Download' };
export const revalidate = 300;

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export default async function DownloadPage() {
  const r = await latestRelease();
  return (
    <div>
      <SiteNav />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <h1 className="font-display text-[44px] leading-tight tracking-tight">Wren for your computer</h1>
        <p className="mt-3 max-w-2xl text-[16px] text-muted">
          The desktop app lets agents work on your own Mac or PC with your permission, use your ChatGPT plan, Claude Code, Grok Build or local models, and keep running your tasks while you control them from your phone. It updates itself.
        </p>

        {!r ? (
          <div className="mt-10 rounded-2xl border border-border bg-surface p-6 text-muted shadow-card">The first desktop release is being prepared. Check back soon — the web app works now.</div>
        ) : (
          <>
            <p className="mt-8 text-sm text-faint">
              Version {r.version}
              {r.prerelease && ' (preview)'} · released {new Date(r.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} ·{' '}
              <a href={r.htmlUrl} className="underline" target="_blank" rel="noreferrer">
                release notes
              </a>
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Platform icon={<Apple className="h-7 w-7" />} name="macOS" note="macOS 12 or later" assets={[r.downloads.macArm64 && { label: 'Apple silicon (M1–M4)', a: r.downloads.macArm64 }, r.downloads.macX64 && { label: 'Intel', a: r.downloads.macX64 }]} />
              <Platform icon={<MonitorDown className="h-7 w-7" />} name="Windows" note="Windows 10 or 11, 64-bit" assets={[r.downloads.windows && { label: 'Windows installer (x64)', a: r.downloads.windows }]} />
            </div>
          </>
        )}

        <div className="mt-10 rounded-2xl border border-warning/30 bg-warning-soft/50 p-5">
          <p className="flex items-center gap-2 font-semibold text-warning">
            <ShieldAlert className="h-5 w-5" /> First launch on an unsigned preview
          </p>
          <p className="mt-2 text-sm text-muted">These preview builds are not yet signed with an Apple Developer ID or a Windows code-signing certificate, so your OS will warn you the first time. Updates are verified separately with Wren’s own signing key.</p>
          <ul className="mt-3 space-y-1.5 text-sm text-muted">
            <li>
              <b className="text-text">macOS:</b> open the .dmg, drag Wren to Applications, then open it. If macOS says it can’t verify the developer, go to System Settings → Privacy & Security and click <b className="text-text">Open Anyway</b>.
            </li>
            <li>
              <b className="text-text">Windows:</b> if SmartScreen appears, click <b className="text-text">More info → Run anyway</b>. Wren installs for your user account only (no admin needed).
            </li>
          </ul>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {[
            ['Sign in', 'Open Wren and sign in with your Wren account. The computer links itself after you approve it.'],
            ['Choose folders', 'Pick which folders agents may use. Everything else is off-limits, and risky actions ask first.'],
            ['Bring your plan', 'Continue with ChatGPT, sign in to Claude Code or Grok Build, or point Wren at LM Studio.'],
          ].map(([t, b]) => (
            <div key={t}>
              <p className="font-semibold">{t}</p>
              <p className="mt-1 text-sm text-muted">{b}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-sm text-muted">
          Prefer not to install anything? <Link href="/signup" className="underline">Use Wren on the web</Link> — cloud agents keep working even when your computer is off. Source code:{' '}
          <a href="https://github.com/tamoghnakabi-wq/wren" className="inline-flex items-center gap-1 underline" target="_blank" rel="noreferrer">
            GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function Platform({ icon, name, note, assets }: { icon: React.ReactNode; name: string; note: string; assets: (false | undefined | { label: string; a: ReleaseAsset })[] }) {
  const list = assets.filter(Boolean) as { label: string; a: ReleaseAsset }[];
  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-lg font-semibold">{name}</p>
          <p className="text-[13px] text-faint">{note}</p>
        </div>
      </div>
      <div className="mt-5 space-y-2">
        {list.length ? (
          list.map(({ label, a }) => (
            <a key={a.url} href={a.url} className="flex items-center justify-between rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-fg hover:opacity-90">
              <span className="flex items-center gap-2">
                <Download className="h-4 w-4" /> {label}
              </span>
              <span className="opacity-70">{mb(a.size)}</span>
            </a>
          ))
        ) : (
          <p className="text-sm text-muted">Not available in this release yet.</p>
        )}
      </div>
    </div>
  );
}
