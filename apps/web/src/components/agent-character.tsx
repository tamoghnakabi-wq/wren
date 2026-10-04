'use client';

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

// Wren's agent characters: small hand-drawn SVG companions, one per agent.
// Each has its own silhouette and a signature motion; all share one face and
// six moods. Animation is pure CSS (globals.css, "Agent characters"), honours
// prefers-reduced-motion, and success/error settle after a few seconds so
// lists never keep bouncing.

import type { CharacterKey, Mood } from '@/lib/characters';

export type { CharacterKey, Mood };

const PALETTE: Record<string, { hi: string; base: string; lo: string; deep: string }> = {
  violet: { hi: '#b6abff', base: '#8b7cf6', lo: '#6a57e3', deep: '#5242c2' },
  blue: { hi: '#9ccbff', base: '#5aa2f8', lo: '#2f6fe4', deep: '#2557bd' },
  teal: { hi: '#8ee8db', base: '#3cc6b4', lo: '#14968a', deep: '#0f786f' },
  green: { hi: '#aee9a6', base: '#6acb6a', lo: '#3a9f45', deep: '#2b7f36' },
  amber: { hi: '#ffe08f', base: '#f8c246', lo: '#e09a12', deep: '#b9780a' },
  orange: { hi: '#ffc19c', base: '#f6935c', lo: '#e0602a', deep: '#b8481b' },
  rose: { hi: '#ffb7cd', base: '#f47aa0', lo: '#d9466f', deep: '#b13158' },
  slate: { hi: '#c3cad6', base: '#8a96a8', lo: '#5b6577', deep: '#474f5e' },
};

const INK = '#231f33';
const BLUSH = '#ff6f91';

type Pal = (typeof PALETTE)[string] & { color: string };

interface Build {
  back?: ReactNode;
  body: ReactNode;
  front?: ReactNode;
  face: [number, number];
  limbs: [[number, number], [number, number]];
  /** Overlapping body parts (Puff) would double the shared highlight; they draw their own. */
  noSheen?: boolean;
}

const accent = (p: Pal, def: string, alt: string, clash: string[]) => (clash.includes(p.color) ? alt : def);

const BUILD: Record<CharacterKey, (p: Pal) => Build> = {
  // A round wren: cocked, barred tail and a little crest.
  pip: (p) => ({
    back: (
      <g className="wc-tail" style={{ transformOrigin: '45px 40px' }}>
        <path d="M43 41C46 34 50 24 54.5 16.5C57.5 19.5 57 27 52.5 34C50.5 37 47.5 39.8 44.5 41.6Z" fill={p.deep} />
        <path d="M49.4 26.6 53.4 28.6M47.6 31.2 51 33" stroke={p.lo} strokeWidth="1.1" strokeLinecap="round" />
      </g>
    ),
    body: <ellipse cx="31" cy="39" rx="17.5" ry="16.5" />,
    front: (
      <>
        <ellipse cx="31" cy="46.6" rx="10.5" ry="7" fill="#fff" opacity=".22" />
        <path d="M27.6 24.2C26.8 19.6 28.6 16.4 31.8 15.6 31 18.6 31.8 21.2 33.6 23.4Z" fill={p.lo} />
        <path d="M31.4 23.2C31.6 19.4 33.8 17.2 36.8 17.2 35.4 19.6 35.4 21.8 36.4 23.8Z" fill={p.base} />
      </>
    ),
    face: [31, 37],
    limbs: [[15, 41.5], [47, 41.5]],
  }),
  // Fox-eared and bright-eyed; ears twitch now and then.
  kit: (p) => ({
    back: (
      <g className="wc-ears" style={{ transformOrigin: '32px 30px' }}>
        <path d="M18 31 19.4 14C19.5 12.6 20.6 12.2 21.6 13L30.6 22.4Z" fill={p.base} stroke={p.base} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M46 31 44.6 14C44.5 12.6 43.4 12.2 42.4 13L33.4 22.4Z" fill={p.base} stroke={p.base} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M20.7 26.6 21.5 17.8 27.4 23.3Z" fill="#ffc7d6" />
        <path d="M43.3 26.6 42.5 17.8 36.6 23.3Z" fill="#ffc7d6" />
      </g>
    ),
    body: <circle cx="32" cy="39.5" r="17" />,
    front: <ellipse cx="32" cy="45.2" rx="7.8" ry="5.3" fill="#fff" opacity=".3" />,
    face: [32, 37.5],
    limbs: [[16.4, 43], [47.6, 43]],
  }),
  // A soft robot: visor face, side bolts and a glowing antenna.
  bolt: (p) => {
    const bulb = accent(p, '#ffd166', '#fff3c4', ['amber', 'orange']);
    return {
      back: (
        <>
          <line x1="32" y1="23" x2="32" y2="14.6" stroke={p.deep} strokeWidth="2.2" strokeLinecap="round" />
          <circle className="wc-glow" cx="32" cy="12.2" r="5.8" fill={bulb} style={{ transformOrigin: '32px 12.2px' }} />
          <circle cx="32" cy="12.2" r="3.2" fill={bulb} />
          <rect x="11.6" y="32.5" width="5" height="10" rx="2.5" fill={p.deep} />
          <rect x="47.4" y="32.5" width="5" height="10" rx="2.5" fill={p.deep} />
        </>
      ),
      body: <rect x="15" y="22" width="34" height="33.5" rx="12.5" />,
      front: <rect x="19.5" y="28.5" width="25" height="17.5" rx="8" fill="#fff" opacity=".2" />,
      face: [32, 37],
      limbs: [[17, 45.5], [47, 45.5]],
    };
  },
  // A seedling: two leaves that sway.
  sprout: (p) => {
    const leaf = accent(p, '#5fcf73', '#2f8f3f', ['green', 'teal']);
    const vein = accent(p, '#2f9e44', '#1f6a2b', ['green', 'teal']);
    return {
      front: (
        <g className="wc-leaves" style={{ transformOrigin: '32.5px 22px' }}>
          <path d="M32 23C31.8 20 32.3 17.6 33.2 15.4" stroke={vein} strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M32.6 17.6C27.4 18 23.4 15.6 21.4 11.2 26.6 10.2 31 12.6 32.6 17.6Z" fill={leaf} />
          <path d="M33.4 15.6C35.6 11 39.6 8.6 44.4 9.2 43.2 13.8 39.2 16.6 33.4 15.6Z" fill={leaf} />
          <path d="M31.2 16.4Q27.4 14.6 24.4 12.2M34.8 14.4Q38.6 11.4 42 10.4" stroke={vein} strokeWidth=".9" opacity=".55" fill="none" strokeLinecap="round" />
        </g>
      ),
      body: <circle cx="32" cy="39.5" r="17.5" />,
      face: [32, 39],
      limbs: [[16, 42], [48, 42]],
    };
  },
  // A tiny planet with a rocking ring.
  orbit: (p) => {
    const ring = (front: boolean) => (
      <g className="wc-ring" style={{ transformOrigin: '32px 40px' }}>
        {front ? (
          <path d="M6 40A26 6.6 0 0 0 58 40" transform="rotate(-14 32 40)" fill="none" stroke={p.deep} strokeWidth="2.6" strokeLinecap="round" />
        ) : (
          <ellipse cx="32" cy="40" rx="26" ry="6.6" transform="rotate(-14 32 40)" fill="none" stroke={p.deep} strokeWidth="2.6" opacity=".45" />
        )}
      </g>
    );
    return {
      back: ring(false),
      body: <circle cx="32" cy="38" r="16.5" />,
      front: (
        <>
          <circle cx="24.5" cy="31" r="2.2" fill="#fff" opacity=".18" />
          <circle cx="40.5" cy="45" r="1.6" fill={p.lo} opacity=".35" />
          {ring(true)}
        </>
      ),
      face: [32, 36.5],
      limbs: [[16.6, 40.5], [47.4, 40.5]],
    };
  },
  // A tall bean in a cosy scarf.
  bean: (p) => {
    const scarf = accent(p, '#ef6f3c', '#f8c246', ['orange', 'rose', 'amber']);
    const scarfDeep = accent(p, '#c9542a', '#d99c1a', ['orange', 'rose', 'amber']);
    return {
      body: <rect x="19" y="15.5" width="26" height="41.5" rx="13" />,
      front: (
        <>
          <path className="wc-scarf" style={{ transformOrigin: '41px 47px' }} d="M38.6 47.4 43.6 46.4 45.8 55.2 40.6 56.2Z" fill={scarfDeep} />
          <path d="M18.8 41.6Q32 46.4 45.2 41.6L45.2 46.4Q32 51.2 18.8 46.4Z" fill={scarf} />
          <path d="M19.4 44.2Q32 48.8 44.6 44.2" stroke="#fff" strokeWidth="1" opacity=".35" fill="none" />
        </>
      ),
      face: [32, 31],
      limbs: [[19.6, 47.5], [44.4, 47.5]],
    };
  },
  // A little cloud with bumps that gently puff.
  puff: () => ({
    body: (
      <>
        <circle className="wc-bump" cx="22" cy="32" r="9.5" style={{ transformOrigin: '22px 32px' }} />
        <circle className="wc-bump" cx="32.5" cy="26.5" r="11.5" style={{ transformOrigin: '32.5px 26.5px', animationDelay: 'calc(var(--wc-d, 0s) - 1.2s)' }} />
        <circle className="wc-bump" cx="43" cy="32" r="9.5" style={{ transformOrigin: '43px 32px', animationDelay: 'calc(var(--wc-d, 0s) - 2.4s)' }} />
        <ellipse cx="32" cy="42" rx="19.5" ry="14" />
      </>
    ),
    front: (
      <>
        <ellipse cx="27" cy="24.5" rx="6.5" ry="4" transform="rotate(-24 27 24.5)" fill="#fff" opacity=".32" />
        <ellipse cx="18.6" cy="31" rx="3.2" ry="2.2" transform="rotate(-30 18.6 31)" fill="#fff" opacity=".22" />
      </>
    ),
    noSheen: true,
    face: [32, 39],
    limbs: [[14.8, 43], [49.2, 43]],
  }),
  // A dewdrop with a moving gleam.
  drop: () => ({
    body: <path d="M32 12.5C36.8 21 49.5 29.8 49.5 41.2 49.5 50.6 41.7 57.2 32 57.2 22.3 57.2 14.5 50.6 14.5 41.2 14.5 29.8 27.2 21 32 12.5Z" />,
    front: (
      <>
        <path className="wc-shine" d="M21.6 40.5C21.4 35.6 23.8 31.4 27.4 28.6" stroke="#fff" strokeOpacity=".65" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle className="wc-shine" cx="20.9" cy="44.4" r="1.3" fill="#fff" opacity=".6" />
      </>
    ),
    face: [32, 42],
    limbs: [[15.6, 45], [48.4, 45]],
  }),
};

function Eye({ x, rx, ry, dy = 0 }: { x: number; rx: number; ry: number; dy?: number }) {
  return (
    <>
      <ellipse cx={x} cy={dy} rx={rx} ry={ry} fill={INK} />
      <circle cx={x + rx * 0.38} cy={dy - ry * 0.4} r={Math.max(0.8, rx * 0.36)} fill="#fff" />
    </>
  );
}

function Face({ mood, character, beak }: { mood: Mood; character: CharacterKey; beak: string }) {
  const L = -6.4;
  const R = 6.4;
  const line = { stroke: INK, strokeWidth: 1.6, strokeLinecap: 'round' as const, fill: 'none' };
  let eyes: ReactNode;
  let brows: ReactNode = null;
  switch (mood) {
    case 'success':
      eyes = (
        <>
          <path d={`M${L - 3} 1Q${L} -3.2 ${L + 3} 1`} {...line} strokeWidth={2} />
          <path d={`M${R - 3} 1Q${R} -3.2 ${R + 3} 1`} {...line} strokeWidth={2} />
        </>
      );
      break;
    case 'working':
      eyes = (
        <>
          <Eye x={L} rx={2.7} ry={2.7} dy={0.4} />
          <Eye x={R} rx={2.7} ry={2.7} dy={0.4} />
        </>
      );
      brows = <path d={`M${L - 3} -5.2 ${L + 2.4} -3.9M${R + 3} -5.2 ${R - 2.4} -3.9`} {...line} strokeWidth={1.4} />;
      break;
    case 'error':
      eyes = (
        <>
          <Eye x={L} rx={2.4} ry={2.9} dy={0.8} />
          <Eye x={R} rx={2.4} ry={2.9} dy={0.8} />
        </>
      );
      brows = <path d={`M${L - 2.8} -3.6 ${L + 2.4} -5.4M${R + 2.8} -3.6 ${R - 2.4} -5.4`} {...line} strokeWidth={1.4} />;
      break;
    case 'waiting':
      eyes = (
        <>
          <Eye x={L} rx={3} ry={3.9} />
          <Eye x={R} rx={3} ry={3.9} />
        </>
      );
      brows = <path d={`M${L - 2.8} -6.6Q${L} -8.4 ${L + 2.6} -6.8M${R - 2.6} -6.8Q${R} -8.4 ${R + 2.8} -6.6`} {...line} strokeWidth={1.3} />;
      break;
    case 'thinking':
      eyes = (
        <g className="wc-gaze">
          <Eye x={L} rx={2.6} ry={3.3} />
          <Eye x={R} rx={2.6} ry={3.3} />
        </g>
      );
      brows = <path d={`M${R - 2.6} -6.4Q${R} -8 ${R + 2.8} -6.4`} {...line} strokeWidth={1.3} />;
      break;
    default:
      eyes = (
        <>
          <Eye x={L} rx={2.7} ry={3.5} />
          <Eye x={R} rx={2.7} ry={3.5} />
        </>
      );
  }

  const blush = mood === 'success' ? 0.55 : mood === 'error' ? 0.18 : 0.34;
  const my = character === 'kit' ? 6.8 : 5.4;
  let mouth: ReactNode;
  if (character === 'pip') {
    mouth =
      mood === 'success' || mood === 'waiting' || mood === 'hello' ? (
        <g transform="translate(0 3.6)">
          <path d="M-2.7 -0.9Q0 -1.9 2.7 -0.9L0 1.3Z" fill={beak} />
          <path d="M-1.9 1.8 1.9 1.8 0 4.2Z" fill={beak} opacity=".85" />
        </g>
      ) : (
        <path transform="translate(0 3.8)" d="M-2.7 -0.6Q0 -1.6 2.7 -0.6L0 2.8Z" fill={beak} />
      );
  } else {
    switch (mood) {
      case 'success':
        mouth = (
          <g transform={`translate(0 ${my - 0.4})`}>
            <path d="M-3.6 -0.4Q0 5.4 3.6 -0.4Z" fill={INK} />
            <path d="M-1.7 2.3Q0 3.7 1.7 2.3Q0 1.4 -1.7 2.3Z" fill="#ff8fa8" />
          </g>
        );
        break;
      case 'thinking':
        mouth = <path transform={`translate(0 ${my})`} d="M-1.7 0.9Q0.4 -0.1 2 0.6" {...line} strokeWidth={1.5} />;
        break;
      case 'working':
        mouth = <path transform={`translate(0 ${my})`} d="M-2 0.2Q0 1.7 2 0.2" {...line} />;
        break;
      case 'error':
        mouth = <path transform={`translate(0 ${my})`} d="M-2.6 1.8Q0 -0.5 2.6 1.8" {...line} />;
        break;
      case 'waiting':
        mouth = <ellipse cx="0" cy={my + 0.4} rx="1.5" ry="1.9" fill={INK} />;
        break;
      default:
        mouth = <path transform={`translate(0 ${my})`} d="M-2.8 0Q0 2.7 2.8 0" {...line} />;
    }
  }

  return (
    <>
      <ellipse cx={-10.6} cy={4.4} rx={2.8} ry={1.7} fill={BLUSH} opacity={blush} />
      <ellipse cx={10.6} cy={4.4} rx={2.8} ry={1.7} fill={BLUSH} opacity={blush} />
      <g className="wc-eyes">{eyes}</g>
      {brows}
      {character === 'kit' && <ellipse cx="0" cy="4.2" rx="1.5" ry="1.05" fill={INK} />}
      {mouth}
    </>
  );
}

const star = (x: number, y: number, r: number) => `M${x} ${y - r}Q${x + r * 0.22} ${y - r * 0.22} ${x + r} ${y}Q${x + r * 0.22} ${y + r * 0.22} ${x} ${y + r}Q${x - r * 0.22} ${y + r * 0.22} ${x - r} ${y}Q${x - r * 0.22} ${y - r * 0.22} ${x} ${y - r}Z`;

const CONFETTI = [
  { x: 29, y: 24, dx: -15, dy: -12, c: '#f8c246' },
  { x: 33, y: 23, dx: 4, dy: -17, c: '#f47aa0' },
  { x: 35, y: 25, dx: 16, dy: -11, c: '#5aa2f8' },
  { x: 27, y: 27, dx: -18, dy: 0, c: '#6acb6a' },
  { x: 37, y: 27, dx: 18, dy: -2, c: '#8b7cf6' },
  { x: 31, y: 25, dx: -6, dy: -18, c: '#f6935c' },
];

function Fx({ mood }: { mood: Mood }) {
  switch (mood) {
    case 'thinking':
      return (
        <g className="wc-fx wc-think" fill="currentColor">
          <circle className="b1" cx="47.6" cy="19.4" r="1.4" style={{ transformOrigin: '47.6px 19.4px' }} />
          <circle className="b2" cx="51.6" cy="14.6" r="2" style={{ transformOrigin: '51.6px 14.6px' }} />
          <g className="b3" style={{ transformOrigin: '57px 8.2px' }}>
            <circle cx="57" cy="8.2" r="4.4" />
            <circle cx="55.3" cy="8.2" r=".65" fill="var(--surface)" />
            <circle cx="57" cy="8.2" r=".65" fill="var(--surface)" />
            <circle cx="58.7" cy="8.2" r=".65" fill="var(--surface)" />
          </g>
        </g>
      );
    case 'working':
      return (
        <g className="wc-fx" fill="#ffc94d">
          <path className="wc-spark s1" d={star(10.5, 22, 3.2)} />
          <path className="wc-spark s2" d={star(54.6, 27.5, 2.5)} />
          <path className="wc-spark s3" d={star(50.5, 13, 1.9)} />
        </g>
      );
    case 'success':
      return (
        <g className="wc-fx">
          {CONFETTI.map((c, i) => (
            <rect key={i} className="wc-conf" x={c.x} y={c.y} width="2.8" height="1.7" rx=".5" fill={c.c} style={{ '--dx': `${c.dx}px`, '--dy': `${c.dy}px`, transformOrigin: `${c.x + 1.4}px ${c.y + 0.85}px`, animationDelay: `${i * 0.05}s` } as CSSProperties} />
          ))}
          <path className="wc-spark s1" d={star(11, 18, 2.8)} fill="#ffc94d" />
          <path className="wc-spark s2" d={star(53.5, 16, 2.4)} fill="#ffc94d" />
        </g>
      );
    case 'error':
      return (
        <g className="wc-fx">
          <path className="wc-sweat" d="M48.4 19.6C48.4 19.6 45.9 23.1 45.9 24.8A2.5 2.5 0 0 0 50.9 24.8C50.9 23.1 48.4 19.6 48.4 19.6Z" fill="#8fd0ff" />
        </g>
      );
    case 'waiting':
      return (
        <g className="wc-fx wc-alert" style={{ transformOrigin: '52.5px 12.5px' }}>
          <circle cx="52.5" cy="12.5" r="6.4" fill="var(--wc-alert)" />
          <rect x="51.6" y="8.5" width="1.8" height="5.1" rx=".9" fill="var(--wc-alert-fg)" />
          <circle cx="52.5" cy="16" r="1.05" fill="var(--wc-alert-fg)" />
        </g>
      );
    default:
      return null;
  }
}

function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface AgentCharacterProps {
  character: CharacterKey;
  color?: string;
  mood?: Mood;
  size?: number;
  /** Desynchronises idle motion between characters on the same screen. */
  seed?: string;
  /** No motion at all (e.g. old messages in a long timeline). */
  still?: boolean;
  className?: string;
  /** Accessible name; without it the character is decorative. */
  title?: string;
}

export function AgentCharacter({ character, color = 'violet', mood = 'idle', size = 48, seed, still, className, title }: AgentCharacterProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const pal: Pal = { ...(PALETTE[color] ?? PALETTE.violet), color: PALETTE[color] ? color : 'violet' };
  const b = BUILD[character] ?? BUILD.pip;
  const build = b(pal);
  const beak = pal.color === 'amber' || pal.color === 'orange' ? '#c2410c' : '#ffb347';

  // Celebrations and stumbles play for a moment, then hold still.
  const [settledMood, setSettledMood] = useState<Mood | null>(null);
  useEffect(() => {
    if (mood !== 'success' && mood !== 'error') return;
    const t = setTimeout(() => setSettledMood(mood), 5000);
    return () => clearTimeout(t);
  }, [mood]);
  const animate = !still && settledMood !== mood;
  const delay = `${-((hash(seed ?? character) % 6000) / 1000).toFixed(2)}s`;

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cx('wc', `wc-${mood}`, animate ? 'wc-anim' : 'wc-still', size < 30 && 'wc-sm', className)}
      style={{ '--wc-d': delay } as CSSProperties}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${uid}b`} x1="16" y1="14" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={pal.hi} />
          <stop offset=".55" stopColor={pal.base} />
          <stop offset="1" stopColor={pal.lo} />
        </linearGradient>
        <radialGradient id={`${uid}h`} cx="25" cy="26" r="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".5" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="wc-shadow" cx="32" cy="59.3" rx="13" ry="2.3" />
      <g className="wc-body">
        {build.back}
        <g fill={`url(#${uid}b)`}>{build.body}</g>
        {!build.noSheen && <g fill={`url(#${uid}h)`}>{build.body}</g>}
        {build.front}
        {build.limbs.map(([x, y], i) => (
          <g key={i} className={cx('wc-limb', i === 0 ? 'wc-limb-l' : 'wc-limb-r')} style={{ transformOrigin: `${x}px ${y}px` }}>
            <ellipse cx={x + (i === 0 ? -0.4 : 0.4)} cy={y + 4.6} rx="3.3" ry="5" fill={pal.lo} transform={`rotate(${i === 0 ? 14 : -14} ${x} ${y})`} />
          </g>
        ))}
        <g transform={`translate(${build.face[0]} ${build.face[1]})`}>
          <g key={mood} className="wc-face">
            <Face mood={mood} character={character} beak={beak} />
          </g>
        </g>
      </g>
      <Fx mood={mood} />
    </svg>
  );
}
