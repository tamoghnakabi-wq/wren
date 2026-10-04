'use client';

import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { isLiveDevice, type Agent } from '@/lib/client/types';
import { Button, Dialog } from '../ui';
import { useApp } from './provider';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Would this agent's next run use the user's ChatGPT plan? (OpenAI models on a signed-in computer.) */
export function useUsesChatGPTPlan(agent?: Agent, runtime?: 'cloud' | 'desktop'): boolean {
  const { profile, devices } = useApp();
  if (!agent || !['openai', 'chatgpt'].includes(agent.model?.source)) return false;
  if ((runtime ?? agent.runtime) !== 'desktop') return false;
  if (agent.model.source === 'openai' && profile?.settings?.openaiAccess === 'api') return false;
  const dev = devices.find((d) => d.id === agent.device_id) ?? devices.filter(isLiveDevice)[0] ?? devices[0];
  return !!dev?.capabilities?.chatgpt?.signedIn && !!dev.capabilities.chatgpt.planUsage;
}

export function ChatGPTPlanBadge() {
  return (
    <p className="mt-2 flex items-center gap-2 px-2 text-[12.5px] text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> Using ChatGPT plan
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
        Manage usage <ExternalLink className="h-3 w-3" />
      </a>
    </p>
  );
}

/** One-time confirmation after the first Sign in with ChatGPT with plan usage (OpenAI UI guidelines). */
export function ChatGPTWelcome() {
  const { desktop, profile } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (desktop?.chatgpt.signedIn && desktop.chatgpt.planUsage && profile && !profile.settings?.chatgptWelcomed) setOpen(true);
  }, [desktop?.chatgpt.signedIn, desktop?.chatgpt.planUsage, profile]);
  if (!open) return null;
  const done = () => {
    setOpen(false);
    api('/api/account/settings', { body: { settings: { chatgptWelcomed: true } } }).catch(() => {});
  };
  return (
    <Dialog open onClose={done} title="You’re using your ChatGPT plan" footer={<Button onClick={done}>Got it</Button>}>
      <p className="text-sm text-muted">
        Eligible usage in Wren on this computer uses your ChatGPT plan. Manage usage in your{' '}
        <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="underline">
          ChatGPT settings
        </a>
        .
      </p>
    </Dialog>
  );
}
