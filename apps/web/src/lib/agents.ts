import { z } from 'zod';
import { DESKTOP_ONLY_SOURCES, type ModelRef } from '@wren/core';

export const SOURCES = ['openai', 'chatgpt', 'anthropic', 'xai', 'gateway', 'platform', 'local', 'claude-code', 'grok-build', 'test'] as const;

export const AgentSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().max(40).optional(),
  color: z.enum(['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'slate']).optional(),
  instructions: z.string().max(20000).optional(),
  model: z
    .object({
      source: z.enum(SOURCES),
      model: z.string().min(1).max(200),
      connectionId: z.string().uuid().optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(),
      baseUrl: z.string().url().optional(),
    })
    .optional(),
  runtime: z.enum(['cloud', 'desktop']).optional(),
  deviceId: z.string().uuid().nullable().optional(),
  tools: z
    .object({
      computer: z.boolean(),
      browser: z.boolean(),
      web: z.boolean(),
      github: z.boolean(),
      memory: z.boolean(),
      notify: z.boolean(),
      screen: z.boolean(),
      mcp: z.array(z.string().uuid()).max(10),
    })
    .partial()
    .optional(),
  autonomy: z.enum(['careful', 'balanced', 'autonomous']).optional(),
  memoryEnabled: z.boolean().optional(),
});

export type AgentInput = z.infer<typeof AgentSchema>;

/** Desktop-only models force the agent onto a desktop device. */
export function normaliseAgent(a: AgentInput): AgentInput {
  if (a.model && DESKTOP_ONLY_SOURCES.includes(a.model.source as ModelRef['source']) && a.model.source !== 'chatgpt') {
    return { ...a, runtime: 'desktop' };
  }
  return a;
}
