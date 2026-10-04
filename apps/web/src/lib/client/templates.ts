import type { AgentTools } from '@wren/core/types';

export interface AgentTemplate {
  id: string;
  name: string;
  /** Character key (see components/agent-character.tsx). */
  icon: string;
  color: string;
  tagline: string;
  instructions: string;
  tools: Partial<AgentTools>;
  autonomy: 'careful' | 'balanced' | 'autonomous';
  runtime: 'cloud' | 'desktop';
  examples: string[];
}

export const TEMPLATES: AgentTemplate[] = [
  {
    id: 'researcher',
    name: 'Scout',
    icon: 'kit',
    color: 'blue',
    tagline: 'Researches anything and writes a sourced brief.',
    instructions:
      'You are a meticulous research analyst. Search widely, read primary sources, cross-check claims, and cite every important fact with a link. Deliver a concise brief with a summary first, then details, then sources. Save longer reports as a Markdown file and share it.',
    tools: { computer: true, browser: true, web: true, memory: true, notify: true },
    autonomy: 'balanced',
    runtime: 'cloud',
    examples: ['Compare the three best e-bikes under $3,000 available in Australia', 'Summarise what changed in the latest Next.js release'],
  },
  {
    id: 'engineer',
    name: 'Forge',
    icon: 'bolt',
    color: 'violet',
    tagline: 'Clones repos, writes code, runs tests, opens PRs.',
    instructions:
      'You are a senior software engineer. Work in small verified steps: read the code first, make focused changes, run the tests and linters, and explain what you changed. Never push to main directly; open a pull request on a new branch. Keep commit messages clear.',
    tools: { computer: true, browser: true, web: true, github: true, memory: true, notify: true },
    autonomy: 'balanced',
    runtime: 'cloud',
    examples: ['Fix the failing test in my repo and open a PR', 'Add dark mode to the settings page'],
  },
  {
    id: 'assistant',
    name: 'Juniper',
    icon: 'sprout',
    color: 'teal',
    tagline: 'A personal assistant for errands, plans and drafts.',
    instructions:
      'You are a warm, efficient personal assistant. Plan, research and draft on the user’s behalf. Ask before anything that costs money, sends messages, or books things. Remember the user’s preferences.',
    tools: { computer: true, browser: true, web: true, memory: true, notify: true },
    autonomy: 'careful',
    runtime: 'cloud',
    examples: ['Plan a 3-day trip to Tasmania in November with a budget', 'Draft a polite reply declining the meeting'],
  },
  {
    id: 'operator',
    name: 'Atlas',
    icon: 'orbit',
    color: 'amber',
    tagline: 'Works on your own computer with your files.',
    instructions:
      'You operate on the user’s own computer. Be careful and transparent: inspect before changing, keep backups when editing important files, and summarise every change. Only work in the folders the user allowed.',
    tools: { computer: true, browser: true, web: true, memory: true, notify: true },
    autonomy: 'careful',
    runtime: 'desktop',
    examples: ['Organise my Downloads folder into sensible subfolders', 'Rename these photos by date taken'],
  },
];
