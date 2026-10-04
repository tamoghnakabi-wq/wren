import type { AgentTools, ModelRef, PlanItem, Risk } from '@wren/core/types';

export interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
  timezone: string;
  settings: { openaiAccess?: 'chatgpt' | 'api'; openaiAllowFallback?: boolean; chatgptWelcomed?: boolean; notifyOnComplete?: boolean; notifyOnApproval?: boolean };
  onboarded_at: string | null;
}

export interface Agent {
  id: string;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  model: ModelRef & { baseUrl?: string };
  runtime: 'cloud' | 'desktop';
  device_id: string | null;
  tools: Partial<AgentTools>;
  autonomy: 'careful' | 'balanced' | 'autonomous';
  memory_enabled: boolean;
  archived_at: string | null;
  last_active_at: string | null;
  created_at: string;
}

export type SessionStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  id: string;
  agent_id: string;
  title: string;
  status: SessionStatus;
  runtime: 'cloud' | 'desktop';
  device_id: string | null;
  last_event_at: string;
  archived_at: string | null;
  created_at: string;
}

export interface Run {
  id: string;
  session_id: string;
  agent_id: string;
  status: SessionStatus;
  runtime: 'cloud' | 'desktop';
  device_id: string | null;
  trigger: string;
  model: ModelRef;
  step: number;
  error: string | null;
  result: string | null;
  usage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number; requests?: number };
  cancel_requested: boolean;
  pause_requested: boolean;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  seq: number;
  session_id: string;
  run_id: string | null;
  type: 'message' | 'tool' | 'status' | 'plan' | 'reasoning';
  status: string | null;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  agent_id: string;
  session_id: string;
  run_id: string;
  event_id: string | null;
  tool: string;
  title: string;
  detail: { args?: Record<string, unknown>; reason?: string | null };
  risk: Risk;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  created_at: string;
  expires_at: string;
}

export interface Artifact {
  id: string;
  agent_id: string | null;
  session_id: string | null;
  name: string;
  mime: string;
  size: number;
  kind: 'file' | 'screenshot' | 'upload';
  source: string;
  created_at: string;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  arch: string | null;
  app_version: string | null;
  capabilities: DeviceCapabilities;
  policy: { folders?: string[]; shell?: boolean; remoteApprovals?: boolean; browser?: boolean };
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface DeviceCapabilities {
  chatgpt?: { signedIn: boolean; email?: string; planUsage?: boolean; models?: { id: string; name: string }[] };
  claudeCode?: { installed: boolean; version?: string; loggedIn?: boolean };
  grokBuild?: { installed: boolean; version?: string; loggedIn?: boolean };
  local?: { baseUrl: string; reachable: boolean; models?: { id: string; name: string }[] };
  browser?: { available: boolean; name?: string };
}

export interface Connection {
  id: string;
  kind: 'model' | 'service';
  provider: string;
  label: string;
  config: Record<string, unknown>;
  secret_hint: string | null;
  status: 'active' | 'error' | 'disabled';
  last_error: string | null;
  created_at: string;
}

export interface Schedule {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id: string | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  session_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface RunLive {
  run_id: string;
  session_id: string;
  image: string | null;
  url: string | null;
  title: string | null;
  updated_at: string;
}

export type { PlanItem };

export const isLiveDevice = (d: Pick<Device, 'last_seen_at'>) => !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 3 * 60 * 1000;
