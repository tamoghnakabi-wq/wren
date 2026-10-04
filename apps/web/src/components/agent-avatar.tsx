import { Bot, BookOpen, Briefcase, Code2, Compass, Globe, Heart, Lightbulb, LineChart, Mail, Megaphone, PenLine, Rocket, Search, ShoppingBag, Sparkles, Wrench } from 'lucide-react';
import { characterFor, type Mood } from '@/lib/characters';
import { AgentCharacter } from './agent-character';

/** Icons older agents were created with (their character is derived from it). */
export const AGENT_ICONS = { sparkles: Sparkles, bot: Bot, code: Code2, search: Search, globe: Globe, pen: PenLine, chart: LineChart, mail: Mail, briefcase: Briefcase, compass: Compass, rocket: Rocket, book: BookOpen, wrench: Wrench, bulb: Lightbulb, heart: Heart, bag: ShoppingBag, megaphone: Megaphone } as const;
export type AgentIcon = keyof typeof AGENT_ICONS;

export const AGENT_COLORS: Record<string, { bg: string; fg: string; ring: string }> = {
  violet: { bg: 'linear-gradient(135deg,#8b7cf6,#6d5ae6)', fg: '#fff', ring: '#8b7cf6' },
  blue: { bg: 'linear-gradient(135deg,#5aa2f8,#2f6fe4)', fg: '#fff', ring: '#5aa2f8' },
  teal: { bg: 'linear-gradient(135deg,#3cc6b4,#14968a)', fg: '#fff', ring: '#3cc6b4' },
  green: { bg: 'linear-gradient(135deg,#6acb6a,#2f9e44)', fg: '#fff', ring: '#6acb6a' },
  amber: { bg: 'linear-gradient(135deg,#f8c246,#e09a12)', fg: '#3a2500', ring: '#f8c246' },
  orange: { bg: 'linear-gradient(135deg,#f6935c,#e0602a)', fg: '#fff', ring: '#f6935c' },
  rose: { bg: 'linear-gradient(135deg,#f47aa0,#d9466f)', fg: '#fff', ring: '#f47aa0' },
  slate: { bg: 'linear-gradient(135deg,#8a96a8,#5b6577)', fg: '#fff', ring: '#8a96a8' },
};

/**
 * An agent's character. `icon` holds the character key (older agents: an icon
 * name, mapped to a character). Pass `mood` directly, or `live` for the
 * running/waiting shorthand used by lists.
 */
export function AgentAvatar({
  icon,
  color,
  size = 36,
  live,
  mood,
  seed,
  still,
  className,
  title,
}: {
  icon?: string;
  color?: string;
  size?: number;
  live?: 'running' | 'waiting' | null;
  mood?: Mood;
  seed?: string;
  still?: boolean;
  className?: string;
  title?: string;
}) {
  const m: Mood = mood ?? (live === 'running' ? 'working' : live === 'waiting' ? 'waiting' : 'idle');
  return <AgentCharacter character={characterFor(icon)} color={color ?? 'violet'} mood={m} size={size} seed={seed ?? icon} still={still} className={className} title={title} />;
}

/** The mood that best describes a task from its status (lists, cards). */
export function sessionMood(status?: string | null): Mood {
  switch (status) {
    case 'running':
    case 'queued':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}
