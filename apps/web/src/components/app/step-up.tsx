'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { setStepUpHandler } from '@/lib/client/api';
import { mfaInfo, type MfaInfo } from '@/lib/client/mfa';
import { SecondStep } from '../second-step';
import { Dialog } from '../ui';

// "Confirm it's you" before sensitive actions. The server decides when it's needed (it answers
// `step_up_required`); api() then calls requestStepUp(). Settings also asks before changes that go
// straight to Supabase Auth (removing an authenticator, new recovery codes).

const Ctx = createContext<() => Promise<boolean>>(async () => false);
export const useStepUp = () => useContext(Ctx);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [mfa, setMfa] = useState<MfaInfo | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const requestStepUp = useCallback(async () => {
    const info = await mfaInfo();
    if (!info) return false;
    if (info.stepUpUntil && info.stepUpUntil > Date.now() + 5000) return true; // verified a moment ago
    pending.current?.(false);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setMfa(info);
    });
  }, []);

  useEffect(() => {
    setStepUpHandler(requestStepUp);
    return () => setStepUpHandler(null);
  }, [requestStepUp]);

  const finish = (ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setMfa(null);
  };

  return (
    <Ctx.Provider value={requestStepUp}>
      {children}
      <Dialog open={!!mfa} onClose={() => finish(false)} title="Confirm it’s you">
        {mfa && <SecondStep mfa={mfa} purpose="step_up" onDone={() => finish(true)} />}
      </Dialog>
    </Ctx.Provider>
  );
}
