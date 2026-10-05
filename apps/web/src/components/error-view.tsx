'use client';

import { useEffect } from 'react';
import { AgentCharacter } from './agent-character';
import { Button, ButtonLink, EmptyState } from './ui';

/** What an error boundary shows: the agent looks worried, and there is a way forward. */
export function ErrorView({ error, retry, home = '/app' }: { error: Error & { digest?: string }; retry: () => void; home?: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4">
      <EmptyState
        art={<AgentCharacter character="pip" color="rose" size={72} mood="error" seed="error" />}
        title="Something went wrong"
        action={
          <>
            <Button onClick={() => retry()}>Try again</Button>
            <ButtonLink href={home} variant="secondary">
              Go home
            </ButtonLink>
          </>
        }
      >
        This page couldn’t load. Your agents and tasks are safe; trying again usually fixes it.
        {error.digest && <span className="mt-2 block font-mono text-[11.5px] text-faint">Reference: {error.digest}</span>}
      </EmptyState>
    </div>
  );
}
