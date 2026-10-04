'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLive } from '@/lib/client/live';
import { desktop, type DesktopStatus } from '@/lib/client/desktop';
import type { Agent, Approval, Device, Notification, Profile, Session } from '@/lib/client/types';

interface AppState {
  userId: string;
  email: string;
  profile: Profile | null;
  agents: Agent[];
  agentsLoading: boolean;
  devices: Device[];
  approvals: Approval[];
  notifications: Notification[];
  unread: number;
  active: Session[];
  desktop: DesktopStatus | null;
  flags: { platform: boolean; testModel: boolean; push: boolean };
  reloadProfile: () => void;
  agentById: (id: string | null | undefined) => Agent | undefined;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

export function AppProvider({ userId, email, children }: { userId: string; email: string; children: ReactNode }) {
  const profile = useLive<Profile>({ table: 'profiles', eq: { id: userId } });
  const agents = useLive<Agent>({ table: 'agents', eq: { user_id: userId }, is: { archived_at: null }, order: { column: 'created_at', ascending: true }, realtimeFilter: { column: 'user_id', value: userId } });
  const devices = useLive<Device>({ table: 'devices', eq: { user_id: userId }, is: { revoked_at: null }, order: { column: 'created_at', ascending: true }, realtimeFilter: { column: 'user_id', value: userId } });
  const approvals = useLive<Approval>({ table: 'approvals', eq: { user_id: userId, status: 'pending' }, order: { column: 'created_at' }, limit: 50, realtimeFilter: { column: 'user_id', value: userId } });
  const notifications = useLive<Notification>({ table: 'notifications', eq: { user_id: userId }, order: { column: 'created_at' }, limit: 60, realtimeFilter: { column: 'user_id', value: userId } });
  const active = useLive<Session>({
    table: 'sessions',
    eq: { user_id: userId },
    inList: { column: 'status', values: ['queued', 'running', 'waiting', 'paused'] },
    order: { column: 'last_event_at' },
    limit: 30,
    realtimeFilter: { column: 'user_id', value: userId },
  });
  const [desk, setDesk] = useState<DesktopStatus | null>(null);
  const [flags, setFlags] = useState({ platform: false, testModel: false, push: false });
  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.flags && setFlags(j.flags))
      .catch(() => {});
  }, []);

  // First visit: adopt the browser's time zone instead of the UTC default.
  const prof = profile.rows[0];
  useEffect(() => {
    if (!prof || prof.timezone !== 'UTC' || prof.settings?.tzChecked) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    fetch('/api/account/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tz && tz !== 'UTC' ? { timezone: tz, settings: { tzChecked: true } } : { settings: { tzChecked: true } }) }).catch(() => {});
  }, [prof]);

  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.status().then(setDesk).catch(() => {});
    return d.onStatus(setDesk);
  }, []);

  // Native notifications inside the desktop app for new in-app notifications.
  useEffect(() => {
    const latest = notifications.rows[0];
    if (!latest || latest.read_at || !desktop()) return;
    if (Date.now() - new Date(latest.created_at).getTime() > 15000) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const n = new Notification(latest.title, { body: latest.body, tag: latest.id });
      n.onclick = () => latest.url && window.location.assign(latest.url);
    }
  }, [notifications.rows]);

  const value = useMemo<AppState>(
    () => ({
      userId,
      email,
      profile: profile.rows[0] ?? null,
      agents: agents.rows,
      agentsLoading: agents.loading,
      devices: devices.rows,
      approvals: approvals.rows,
      notifications: notifications.rows,
      unread: notifications.rows.filter((n) => !n.read_at).length,
      active: active.rows,
      desktop: desk,
      flags,
      reloadProfile: profile.reload,
      agentById: (id) => agents.rows.find((a) => a.id === id),
    }),
    [userId, email, profile.rows, profile.reload, agents.rows, agents.loading, devices.rows, approvals.rows, notifications.rows, active.rows, desk, flags],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
