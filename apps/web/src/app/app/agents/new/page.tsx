'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AgentForm, emptyDraft, toPayload, type AgentDraft } from '@/components/app/agent-form';
import { AgentAvatar } from '@/components/agent-avatar';
import { Button, cx, PageHeader, SkeletonList, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { TEMPLATES } from '@/lib/client/templates';
import type { Agent } from '@/lib/client/types';

export default function NewAgentPage() {
  return (
    <Suspense fallback={<SkeletonList rows={3} avatar={false} className="mt-16" />}>
      <NewAgent />
    </Suspense>
  );
}

function fromTemplate(id: string | null): AgentDraft {
  const t = TEMPLATES.find((x) => x.id === id);
  const d = emptyDraft();
  if (!t) return d;
  return { ...d, name: t.name, icon: t.icon, color: t.color, instructions: t.instructions, runtime: t.runtime, autonomy: t.autonomy, tools: { ...d.tools, ...t.tools, mcp: [] } };
}

function NewAgent() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [template, setTemplate] = useState<string | null>(params.get('template'));
  const [draft, setDraft] = useState<AgentDraft>(() => fromTemplate(params.get('template')));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!draft.name.trim()) return toast('Give your agent a name.', 'error');
    setSaving(true);
    try {
      const a = await api<Agent>('/api/agents', { body: toPayload(draft) });
      toast(`${a.name} is ready.`, 'success');
      router.push(`/app?agent=${a.id}&compose=1`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New agent" subtitle="Start from a template or build your own." />
      <div className="mb-8 flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTemplate(t.id);
              setDraft((d) => ({ ...fromTemplate(t.id), model: d.model }));
            }}
            className={cx('flex shrink-0 items-center gap-2 rounded-full border py-1.5 pr-3.5 pl-1.5 text-sm transition', template === t.id ? 'border-text bg-surface shadow-sm' : 'border-border hover:bg-surface')}
          >
            <AgentAvatar icon={t.icon} color={t.color} size={24} />
            {t.name}
          </button>
        ))}
      </div>
      <AgentForm draft={draft} onChange={setDraft} />
      <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] mt-10 flex justify-end gap-2 rounded-2xl border border-border bg-surface/90 p-3 shadow-pop backdrop-blur lg:bottom-4">
        <Button variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving}>
          Create agent
        </Button>
      </div>
    </div>
  );
}
