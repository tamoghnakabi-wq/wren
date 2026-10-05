import Link from 'next/link';
import { AgentCharacter } from '@/components/agent-character';
import { Logo } from '@/components/brand';
import { ButtonLink } from '@/components/ui';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      <Link href="/" aria-label="Wren home" className="mb-10">
        <Logo />
      </Link>
      <AgentCharacter character="kit" color="blue" size={88} mood="thinking" seed="404" />
      <p className="mt-6 font-mono text-[13px] text-faint">404</p>
      <h1 className="mt-1 font-display text-4xl tracking-tight">This page wandered off</h1>
      <p className="mt-3 max-w-sm text-[15px] text-pretty text-muted">The link may be old, or the page was moved. Your agents are right where you left them.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <ButtonLink href="/app">Open Wren</ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Home page
        </ButtonLink>
      </div>
    </main>
  );
}
