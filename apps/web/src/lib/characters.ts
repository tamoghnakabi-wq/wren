// Agent character data, shared by server and client code (the drawing itself
// lives in components/agent-character.tsx, a client component).

export type Mood = 'idle' | 'thinking' | 'working' | 'success' | 'error' | 'waiting' | 'hello';
export type CharacterKey = 'pip' | 'sprout' | 'bolt' | 'puff' | 'orbit' | 'kit' | 'bean' | 'drop';

export const CHARACTERS: Record<CharacterKey, { name: string; blurb: string }> = {
  pip: { name: 'Pip', blurb: 'A quick, curious little wren.' },
  kit: { name: 'Kit', blurb: 'Sharp ears, great at finding things.' },
  bolt: { name: 'Bolt', blurb: 'A tidy tinkerer who loves a build.' },
  sprout: { name: 'Sprout', blurb: 'Patient and steady, always growing.' },
  orbit: { name: 'Orbit', blurb: 'Keeps the big picture in view.' },
  bean: { name: 'Bean', blurb: 'Organised, warm and reliable.' },
  puff: { name: 'Puff', blurb: 'Soft-spoken and good with words.' },
  drop: { name: 'Drop', blurb: 'Calm, clear and quietly clever.' },
};

export const CHARACTER_KEYS = Object.keys(CHARACTERS) as CharacterKey[];

export const MOOD_LABEL: Record<Exclude<Mood, 'hello'>, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  success: 'Done',
  error: 'Stuck',
  waiting: 'Needs you',
};

/** Older agents stored an icon name; give each a fitting character. */
const ICON_CHARACTER: Record<string, CharacterKey> = {
  sparkles: 'pip', bot: 'bolt', code: 'bolt', wrench: 'bolt', search: 'kit', compass: 'kit', globe: 'orbit', chart: 'orbit', rocket: 'orbit',
  briefcase: 'bean', pen: 'bean', book: 'bean', mail: 'puff', megaphone: 'puff', bulb: 'sprout', heart: 'drop', bag: 'drop',
};

export function characterFor(icon?: string | null): CharacterKey {
  if (icon && icon in CHARACTERS) return icon as CharacterKey;
  return ICON_CHARACTER[icon ?? ''] ?? 'pip';
}
