import { Bot, BookOpen, Briefcase, Code2, Compass, Globe, Heart, Lightbulb, LineChart, Mail, Megaphone, PenLine, Rocket, Search, ShoppingBag, Sparkles, Wrench } from 'lucide-react';
import { cx } from '@/lib/cx';

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

export function AgentAvatar({ icon, color, size = 36, live, className }: { icon?: string; color?: string; size?: number; live?: 'running' | 'waiting' | null; className?: string }) {
  const Icon = AGENT_ICONS[(icon as AgentIcon) ?? 'sparkles'] ?? Sparkles;
  const c = AGENT_COLORS[color ?? 'violet'] ?? AGENT_COLORS.violet;
  return (
    <span className={cx('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      <span className="flex h-full w-full items-center justify-center rounded-[32%] shadow-sm" style={{ background: c.bg, color: c.fg }}>
        <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />
      </span>
      {live && (
        <span className="absolute -right-0.5 -bottom-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface">
          <span className={cx('h-2.5 w-2.5 rounded-full', live === 'running' ? 'animate-wren-pulse bg-success' : 'bg-warning')} />
        </span>
      )}
    </span>
  );
}
